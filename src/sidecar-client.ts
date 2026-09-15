import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const PROTOCOL_VERSION = 1
const MAX_FRAME_BYTES = 1024 * 1024

export interface SidecarFrame {
  readonly v: number
  readonly id: string
  readonly token: string
  readonly type: string
  readonly profile_id: string
  readonly timestamp: string
  readonly payload: Record<string, any>
}

export interface SidecarClientOptions {
  readonly script: string
  readonly profileId: string
  readonly handshakeTimeoutMs?: number
  readonly requestTimeoutMs?: number
  /**
   * Called when the sidecar dies outside an explicit `stop()` — crash, protocol
   * violation, or kill.  Without it the host had no way to learn that the
   * channel was gone, so the settings panel kept reporting 已连接 while no
   * message could arrive or be sent.
   */
  readonly onExit?: (error: Error) => void
  readonly logger: {
    warn(message: string, ...rest: unknown[]): void
    error(message: string, ...rest: unknown[]): void
  }
}

interface PendingRequest {
  readonly resolve: (frame: SidecarFrame) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Private authenticated JSON-lines transport for one platform sidecar. */
export class SidecarClient {
  private process: ChildProcessWithoutNullStreams | undefined
  private input = Buffer.alloc(0)
  private readonly token = randomBytes(32).toString('hex')
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(frame: SidecarFrame) => void>()
  private started: Promise<void> | undefined
  private stopping = false
  private stopPromise: Promise<void> | undefined

  constructor(private readonly options: SidecarClientOptions) {}

  onEvent(listener: (frame: SidecarFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): Promise<void> {
    if (this.stopPromise) return this.stopPromise.then(() => this.start())
    if (this.started !== undefined) return this.started
    this.started = this.spawnAndHandshake().catch((error) => {
      this.process?.kill()
      this.cleanup(error instanceof Error ? error : new Error(String(error)))
      this.process = undefined
      this.started = undefined
      throw error
    })
    return this.started
  }

  async send(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.start()
    this.write(this.frame(type, payload))
  }

  async request(
    type: string,
    payload: Record<string, unknown> = {},
    expectedTypes: ReadonlyArray<string>,
  ): Promise<SidecarFrame> {
    await this.start()
    const id = randomUUID()
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000
    return await new Promise<SidecarFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`sidecar request ${type} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (frame) => {
          if (!expectedTypes.includes(frame.type)) {
            reject(new Error(`sidecar request ${type} returned ${frame.type}`))
            return
          }
          resolve(frame)
        },
        reject,
        timer,
      })
      try {
        this.write(this.frame(type, payload, id))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.stopChild()
    try { await this.stopPromise } finally { this.stopPromise = undefined }
  }

  private async stopChild(): Promise<void> {
    const child = this.process
    if (child === undefined) return
    this.stopping = true
    try {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      this.write(this.frame('shutdown', {}))
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000) })]) }
      finally { clearTimeout(timer) }
    } finally {
      if (child.exitCode === null) child.kill()
      this.cleanup(new Error('sidecar stopped'))
      this.process = undefined
      this.started = undefined
      this.stopping = false
    }
  }

  private async spawnAndHandshake(): Promise<void> {
    // `--no-warnings`: the child inherits the host's environment, so Node runtime
    // notices from it (e.g. "(node:123) [UNDICI-EHPA] Warning: …" when
    // NODE_USE_ENV_PROXY is set) were forwarded to the plugin log as warnings and
    // made every healthy spawn look like a failure.  These are Node chatter, not
    // sidecar diagnostics; the sidecar's own stderr writes are unaffected.
    const child = spawn(process.execPath, ['--no-warnings', this.options.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    })
    this.process = child
    const fail = (error: Error): void => {
      if (this.process !== child) return
      if (!this.stopping) this.options.logger.error(error.message)
      child.kill()
      this.cleanup(error)
      this.process = undefined
      this.started = undefined
      this.notifyExit(error)
    }
    child.once('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim()
      if (message !== '') this.options.logger.warn(`[sidecar] ${message.slice(0, 1000)}`)
    })
    child.once('exit', (code, signal) => {
      if (this.process !== child) return
      const error = new Error(`sidecar exited (${code ?? signal ?? 'unknown'})`)
      const unexpected = !this.stopping
      if (unexpected) this.options.logger.error(error.message)
      this.cleanup(error)
      this.process = undefined
      this.started = undefined
      this.notifyExit(error)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.process !== child) return
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        if (this.input.length + end - offset > MAX_FRAME_BYTES) {
          this.protocolFailure('oversized frame')
          return
        }
        this.input = Buffer.concat([this.input, chunk.subarray(offset, end)])
        if (newline < 0) return
        const line = this.input.toString('utf8')
        this.input = Buffer.alloc(0)
        this.acceptLine(line)
        if (this.process !== child) return
        offset = newline + 1
      }
    })

    const id = randomUUID()
    const timeoutMs = this.options.handshakeTimeoutMs ?? 10_000
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('sidecar handshake timed out'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (frame) => frame.type === 'hello.ack'
          ? resolve()
          : reject(new Error(`unexpected handshake response ${frame.type}`)),
        reject,
        timer,
      })
      this.write(this.frame('hello', {}, id))
    })
  }

  private acceptLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
      this.protocolFailure('oversized frame')
      return
    }
    let frame: SidecarFrame
    try {
      frame = JSON.parse(line) as SidecarFrame
    } catch {
      this.protocolFailure('invalid JSON')
      return
    }
    if (!frame || typeof frame !== 'object' || frame.v !== PROTOCOL_VERSION || frame.token !== this.token
      || typeof frame.id !== 'string' || !frame.id || typeof frame.type !== 'string' || !frame.type
      || !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) {
      this.protocolFailure('invalid authenticated frame')
      return
    }
    const pending = this.pending.get(frame.id)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      pending.resolve(frame)
      return
    }
    for (const listener of this.listeners) {
      try { listener(frame) } catch { this.options.logger.warn('sidecar event listener failed') }
    }
  }

  private protocolFailure(reason: string): void {
    const error = new Error(`sidecar protocol failure: ${reason}`)
    this.options.logger.error(error.message)
    this.process?.kill()
    this.cleanup(error)
    this.process = undefined
    this.started = undefined
    this.notifyExit(error)
  }

  /**
   * Report an unexpected sidecar death to the owner, at most once per death.
   * A deliberate `stop()` never notifies, so a normal shutdown cannot be
   * mistaken for a crash and start a reconnect loop.
   */
  private notifyExit(error: Error): void {
    if (this.stopping) return
    try {
      this.options.onExit?.(error)
    } catch {
      this.options.logger.warn('sidecar exit handler failed')
    }
  }

  private cleanup(error: Error): void {
    this.input = Buffer.alloc(0)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private frame(type: string, payload: Record<string, unknown>, id = randomUUID()): SidecarFrame {
    return {
      v: PROTOCOL_VERSION,
      id,
      token: this.token,
      type,
      profile_id: this.options.profileId,
      timestamp: new Date().toISOString(),
      payload,
    }
  }

  private write(frame: SidecarFrame): void {
    const child = this.process
    if (child === undefined || child.stdin.destroyed) throw new Error('sidecar is not running')
    const encoded = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) throw new Error('sidecar request exceeds size limit')
    child.stdin.write(encoded)
  }
}
