import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'

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
  private lines: ReadLineInterface | undefined
  private readonly token = randomBytes(32).toString('hex')
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(frame: SidecarFrame) => void>()
  private started: Promise<void> | undefined
  private stopping = false

  constructor(private readonly options: SidecarClientOptions) {}

  onEvent(listener: (frame: SidecarFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): Promise<void> {
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
    const child = this.process
    if (child === undefined) return
    this.stopping = true
    try {
      const ack = this.request('shutdown', {}, ['shutdown.ack']).catch(() => undefined)
      await Promise.race([ack, new Promise((resolve) => setTimeout(resolve, 2_000))])
    } finally {
      if (child.exitCode === null) child.kill()
      this.cleanup(new Error('sidecar stopped'))
      this.process = undefined
      this.started = undefined
      this.stopping = false
    }
  }

  private async spawnAndHandshake(): Promise<void> {
    const child = spawn(process.execPath, [this.options.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    })
    this.process = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim()
      if (message !== '') this.options.logger.warn(`[sidecar] ${message.slice(0, 1000)}`)
    })
    child.once('exit', (code, signal) => {
      const error = new Error(`sidecar exited (${code ?? signal ?? 'unknown'})`)
      if (!this.stopping) this.options.logger.error(error.message)
      this.cleanup(error)
      this.process = undefined
      this.started = undefined
    })
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line) => this.acceptLine(line))

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
    if (frame.v !== PROTOCOL_VERSION || frame.token !== this.token || typeof frame.type !== 'string') {
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
    for (const listener of this.listeners) listener(frame)
  }

  private protocolFailure(reason: string): void {
    const error = new Error(`sidecar protocol failure: ${reason}`)
    this.options.logger.error(error.message)
    this.process?.kill()
    this.cleanup(error)
  }

  private cleanup(error: Error): void {
    this.lines?.close()
    this.lines = undefined
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
