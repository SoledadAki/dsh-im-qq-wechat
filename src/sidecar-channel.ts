import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ApprovalOutcome,
  ApprovalPrompt,
  BridgeQuestion,
  ChannelAdapter,
  ChannelKind,
  ChannelReplyStream,
  ChannelStatus,
  InboundTextMessage,
} from './channel.js'
import { SidecarClient, type SidecarFrame } from './sidecar-client.js'
import { splitMessageText } from './editable-stream.js'

export interface PersistedChannelBinding {
  readonly accountId: string
  readonly ownerUserId: string
  readonly appId?: string
  readonly baseUrl?: string
  readonly cursor?: number
}

export interface ChannelPersistence {
  load(): PersistedChannelBinding | undefined
  save(binding: PersistedChannelBinding): Promise<void>
  clear(): Promise<void>
}

export interface CredentialAccess {
  resolve(ref: string): Promise<{ value: string } | undefined>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

interface PendingApproval {
  readonly kind: 'approval'
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

interface PendingQuestion {
  readonly kind: 'question'
  readonly count: number
  readonly resolve: (answers: string[]) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
}

type PendingInteraction = PendingApproval | PendingQuestion

export interface SidecarChannelOptions {
  readonly kind: ChannelKind
  readonly profileId: string
  readonly stateDir: string
  readonly secretRef: string
  readonly credentials: CredentialAccess
  readonly persistence: ChannelPersistence
  readonly interactionTimeoutMs?: number
  readonly logger: {
    info(message: string, ...rest: unknown[]): void
    warn(message: string, ...rest: unknown[]): void
    error(message: string, ...rest: unknown[]): void
  }
}

/** QQ Gateway / Weixin iLink adapter backed by the audited LiaoData sidecars. */
export class SidecarChannelAdapter implements ChannelAdapter {
  readonly kind: ChannelKind

  private readonly client: SidecarClient
  private readonly listeners = new Set<(message: InboundTextMessage) => void>()
  private readonly seen = new Set<string>()
  private readonly interactions = new Map<string, PendingInteraction>()
  private status: ChannelStatus = { state: 'idle', connected: false }
  private bindingTaskId: string | undefined
  private qrWaiter: { resolve(value: { qrDataUrl: string }): void; reject(error: Error): void } | undefined
  private started = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private intentionalStop = false

  constructor(private readonly options: SidecarChannelOptions) {
    this.kind = options.kind
    const script = fileURLToPath(new URL(`../sidecar/${options.kind === 'qq' ? 'qq' : 'weixin'}/main.mjs`, import.meta.url))
    this.client = new SidecarClient({
      script,
      profileId: options.profileId,
      logger: options.logger,
      requestTimeoutMs: 30_000,
    })
    this.client.onEvent((frame) => this.handleEvent(frame))
  }

  async start(): Promise<void> {
    if (this.started) {
      // `stop()` intentionally keeps the sidecar process alive so a later
      // Connect action can reuse it. Re-start the platform transport instead
      // of returning early (the old early return made reconnect a no-op).
      this.intentionalStop = false
      const binding = this.options.persistence.load()
      if (binding === undefined) {
        this.status = { state: 'idle', connected: false }
        return
      }
      const secret = await this.options.credentials.resolve(this.options.secretRef)
      if (secret === undefined) {
        this.status = { state: 'idle', connected: false, error: '凭据已丢失，请重新绑定' }
        return
      }
      try {
        await this.startTransport(binding, secret.value)
        this.status = { state: 'bound', connected: false, boundUserId: binding.ownerUserId }
      } finally {
        secret.value = ''
      }
      return
    }
    this.intentionalStop = false
    await mkdir(this.options.stateDir, { recursive: true })
    await this.client.start()
    this.started = true
    const binding = this.options.persistence.load()
    if (binding === undefined) {
      this.status = { state: 'idle', connected: false }
      return
    }
    const secret = await this.options.credentials.resolve(this.options.secretRef)
    if (secret === undefined) {
      this.status = { state: 'idle', connected: true, error: '凭据已丢失，请重新绑定' }
      return
    }
    try {
      await this.startTransport(binding, secret.value)
      this.status = { state: 'bound', connected: false, boundUserId: binding.ownerUserId }
    } finally {
      secret.value = ''
    }
  }

  async stop(): Promise<void> {
    this.intentionalStop = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const binding = this.options.persistence.load()
    if (binding !== undefined && this.started) {
      await this.client.send(this.kind === 'qq' ? 'gateway.stop' : 'monitor.stop', {
        account_id: binding.accountId,
      }).catch(() => undefined)
    }
    this.status = { ...this.status, connected: false }
  }

  async dispose(): Promise<void> {
    await this.stop()
    this.cancelBindingState(new Error('通道已关闭'))
    this.cancelInteractions()
    await this.client.stop()
    this.started = false
    this.listeners.clear()
    this.seen.clear()
  }

  async sendText(userId: string, text: string, replyToId?: string): Promise<void> {
    const binding = this.requireOwner(userId)
    for (const textChunk of splitMessageText(text, this.kind === 'qq' ? 5000 : 4000)) {
    const frame = await this.client.request('message.send', {
      account_id: binding.accountId,
      target_id: userId,
      reply_to_id: replyToId ?? '',
      text: textChunk,
      proactive: replyToId === undefined,
    }, ['message.sent', 'message.send_failed'])
    if (frame.type === 'message.send_failed') throw new Error(`${this.kind} message send failed`)
    }
  }

  async openReplyStream(userId: string, replyToId: string): Promise<ChannelReplyStream | undefined> {
    if (this.kind !== 'qq') return undefined
    const binding = this.requireOwner(userId)
    const streamId = randomUUID()
    const request = async (type: string, extra: Record<string, unknown> = {}): Promise<void> => {
      const frame = await this.client.request(type, { account_id: binding.accountId, stream_id: streamId, ...extra }, ['stream.ok', 'stream.failed'])
      if (frame.type === 'stream.failed') throw new Error('QQ native stream failed')
    }
    const sendRemainder = (text: string) => this.sendText(userId, text)
    await request('stream.start', { target_id: userId, reply_to_id: replyToId })
    let closed = false
    return {
      async update(text) { if (!closed && text.trim()) await request('stream.update', { text }) },
      async finish(text) {
        if (closed) return
        closed = true
        const chunks = splitMessageText(text, 5000)
        await request('stream.finish', { text: chunks[0] ?? '处理完成。' })
        for (const chunk of chunks.slice(1)) await sendRemainder(chunk)
      },
      async cancel() { if (closed) return; closed = true; await request('stream.cancel') },
    }
  }

  async askApproval(userId: string, prompt: ApprovalPrompt, signal?: AbortSignal): Promise<ApprovalOutcome> {
    this.requireOwner(userId)
    if (signal?.aborted) return 'cancelled'
    const id = this.interactionId()
    const timeoutMs = this.options.interactionTimeoutMs ?? 5 * 60_000
    const answer = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.interactions.get(id)
        if (pending?.signal !== undefined && pending.onAbort !== undefined) pending.signal.removeEventListener('abort', pending.onAbort)
        this.interactions.delete(id)
        resolve('unavailable')
      }, timeoutMs)
      const onAbort = () => this.finishInteraction(id, 'cancelled')
      this.interactions.set(id, { kind: 'approval', resolve, timer, signal, onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) onAbort()
    })
    try {
      void this.sendText(userId,
        `需要安全审核 #${id}\n操作：${prompt.toolName}${prompt.reason ? `\n原因：${prompt.reason}` : ''}` +
        `\n回复 /同意 ${id} 或 /拒绝 ${id}` +
        `\n（也可用 /approve 或 /reject）`).catch(() => this.finishInteraction(id, 'unavailable'))
    } catch {
      this.finishInteraction(id, 'unavailable')
    }
    return await answer
  }

  async askQuestion(userId: string, questions: ReadonlyArray<BridgeQuestion>, signal?: AbortSignal): Promise<string[]> {
    this.requireOwner(userId)
    if (signal?.aborted) throw new Error('用户问题已取消')
    if (questions.length === 0) return []
    const id = this.interactionId()
    const timeoutMs = this.options.interactionTimeoutMs ?? 5 * 60_000
    const answer = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.interactions.get(id)
        if (pending?.signal !== undefined && pending.onAbort !== undefined) pending.signal.removeEventListener('abort', pending.onAbort)
        this.interactions.delete(id)
        reject(new Error('用户问题已超时'))
      }, timeoutMs)
      const onAbort = () => this.rejectQuestion(id, new Error('用户问题已取消'))
      this.interactions.set(id, { kind: 'question', count: questions.length, resolve, reject, timer, signal, onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted === true) onAbort()
    })
    void answer.catch(() => undefined)
    const rendered = questions.map((question, index) => {
      const choices = question.options?.map((option) => option.label).join(' / ')
      return `${index + 1}. ${question.question}${question.detail ? `\n${question.detail}` : ''}${choices ? ` [${choices}]` : ''}`
    }).join('\n')
    try {
      void this.sendText(userId, `问题 ${id}\n${rendered}\n回复 /answer ${id} 答案1 | 答案2`).catch((error) => this.rejectQuestion(id, error instanceof Error ? error : new Error(String(error))))
    } catch (error) {
      this.rejectQuestion(id, error instanceof Error ? error : new Error(String(error)))
    }
    return await answer
  }

  async startBinding(): Promise<{ qrDataUrl: string }> {
    await this.start()
    await this.cancelBinding()
    const taskId = randomUUID()
    this.bindingTaskId = taskId
    this.status = { state: 'awaiting-code', connected: false }
    const qr = new Promise<{ qrDataUrl: string }>((resolve, reject) => {
      this.qrWaiter = { resolve, reject }
    })
    await this.client.send('binding.start', { task_id: taskId })
    return await qr
  }

  async submitCode(_userId: string, code: string): Promise<{ ok: boolean; error?: string }> {
    if (this.kind === 'qq') {
      return this.status.state === 'bound'
        ? { ok: true }
        : { ok: false, error: 'QQ 扫码尚未确认' }
    }
    // WeChat iLink QR binding is completed in the WeChat client and has no
    // separate verification-code step.
    if (this.kind === 'wechat') return { ok: true }
    if (this.bindingTaskId === undefined || this.status.state !== 'awaiting-code') {
      return { ok: false, error: '微信绑定任务已失效' }
    }
    if (!/^\d{4,8}$/.test(code.trim())) return { ok: false, error: '验证码格式错误' }
    await this.client.send('binding.verify', { task_id: this.bindingTaskId, verify_code: code.trim() })
    return { ok: true }
  }

  async cancelBinding(): Promise<void> {
    if (this.bindingTaskId !== undefined && this.started) {
      await this.client.send('binding.cancel', { task_id: this.bindingTaskId }).catch(() => undefined)
    }
    this.cancelBindingState(new Error('绑定已取消'))
    if (this.status.state !== 'bound') this.status = { state: 'idle', connected: this.started }
  }

  async unbind(): Promise<void> {
    await this.stop()
    await this.options.credentials.unset(this.options.secretRef)
    await this.options.persistence.clear()
    this.status = { state: 'idle', connected: false }
  }

  getStatus(): ChannelStatus {
    // The sidecar process can remain alive after credentials disappear or a
    // binding fails. That process liveness must never be exposed as a platform
    // connection in the settings UI.
    if (this.status.state === 'idle' && this.status.error !== undefined) {
      return { ...this.status, connected: false }
    }
    return { ...this.status }
  }

  onInbound(callback: (message: InboundTextMessage) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private handleEvent(frame: SidecarFrame): void {
    const payload = frame.payload
    if (frame.type === 'binding.qr_displayed' && payload.task_id === this.bindingTaskId) {
      const qrDataUrl = String(payload.qr_url || '')
      if (qrDataUrl === '') return
      this.status = { ...this.status, state: 'awaiting-code', qrDataUrl, error: undefined }
      this.qrWaiter?.resolve({ qrDataUrl })
      this.qrWaiter = undefined
      return
    }
    if (frame.type === 'binding.credentials' && payload.task_id === this.bindingTaskId) {
      void this.acceptCredentials(payload)
      return
    }
    if (frame.type === 'binding.qr_expired') {
      if (this.kind === 'wechat') return
      this.status = { ...this.status, error: '二维码已过期，正在刷新' }
      return
    }
    if (frame.type === 'binding.failed') {
      const message = String(payload.message || '二维码已失效，请重新绑定')
      this.cancelBindingState(new Error(message))
      this.status = { state: 'idle', connected: false, error: message }
      return
    }
    if (frame.type === 'gateway.ready' || frame.type === 'gateway.resumed' || frame.type === 'monitor.ready') {
      this.reconnectAttempts = 0
      this.status = { ...this.status, state: 'bound', connected: true }
      return
    }
    if (frame.type === 'gateway.failed' || frame.type === 'monitor.failed' || frame.type === 'monitor.paused') {
      this.status = { ...this.status, connected: false, error: String(payload.message || '连接中断') }
      if (frame.type !== 'monitor.paused') this.scheduleReconnect()
      return
    }
    if (frame.type === 'gateway.message' || frame.type === 'monitor.message') this.acceptInbound(payload)
  }

  private async acceptCredentials(payload: Record<string, any>): Promise<void> {
    const taskId = this.bindingTaskId
    try {
      const binding: PersistedChannelBinding = this.kind === 'qq'
        ? {
            accountId: randomUUID(),
            appId: String(payload.app_id || ''),
            ownerUserId: String(payload.user_openid || ''),
          }
        : {
            accountId: String(payload.account_id || ''),
            ownerUserId: String(payload.owner_user_id || ''),
            baseUrl: String(payload.base_url || ''),
          }
      const secret = String(this.kind === 'qq' ? payload.app_secret : payload.bot_token)
      if (!binding.accountId || !binding.ownerUserId || !secret || (this.kind === 'qq' && !binding.appId)) {
        throw new Error('平台没有返回完整凭据')
      }
      await this.options.credentials.set(this.options.secretRef, secret)
      await this.options.persistence.save(binding)
      await this.client.send('binding.credentials_stored', { task_id: taskId ?? '' })
      await this.startTransport(binding, secret)
      this.bindingTaskId = undefined
      this.status = { state: 'bound', connected: false, boundUserId: binding.ownerUserId }
    } catch (error) {
      await this.options.credentials.unset(this.options.secretRef).catch(() => undefined)
      await this.options.persistence.clear().catch(() => undefined)
      this.status = { state: 'idle', connected: true, error: '凭据安全保存失败' }
      this.options.logger.warn(`[${this.kind}] credential handoff failed without logging secret: ${String(error)}`)
    } finally {
      if (this.kind === 'qq') payload.app_secret = ''
      else payload.bot_token = ''
    }
  }

  private async startTransport(binding: PersistedChannelBinding, secret: string): Promise<void> {
    this.intentionalStop = false
    const sessionDir = join(this.options.stateDir, binding.accountId)
    await mkdir(sessionDir, { recursive: true })
    if (this.kind === 'qq') {
      await this.client.send('gateway.start', {
        account_id: binding.accountId,
        app_id: binding.appId,
        app_secret: secret,
        session_dir: sessionDir,
      })
    } else {
      await this.client.send('monitor.start', {
        account_id: binding.accountId,
        base_url: binding.baseUrl,
        bot_token: secret,
        session_dir: sessionDir,
      })
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalStop || this.reconnectTimer !== undefined) return
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 6))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      const binding = this.options.persistence.load()
      if (binding === undefined || this.intentionalStop) return
      void this.options.credentials.resolve(this.options.secretRef).then(async (resolved) => {
        if (resolved === undefined || this.intentionalStop) return
        try {
          await this.startTransport(binding, resolved.value)
        } catch (error) {
          this.options.logger.warn(`[${this.kind}] reconnect failed: ${String(error)}`)
          this.scheduleReconnect()
        } finally {
          resolved.value = ''
        }
      })
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private acceptInbound(payload: Record<string, any>): void {
    const binding = this.options.persistence.load()
    const userId = String(payload.sender_id || '')
    const extId = String(payload.message_id || '')
    if (binding === undefined || userId !== binding.ownerUserId || !extId || this.seen.has(extId)) return
    this.remember(extId)
    const text = String(payload.text || '').trim()
    if (this.acceptInteraction(text)) return
    if (!text) {
      void this.sendText(userId, '当前仅支持文本消息。', extId).catch(() => undefined)
      return
    }
    const message: InboundTextMessage = {
      channel: this.kind,
      userId,
      extId,
      text,
      timestamp: Date.parse(String(payload.timestamp || '')) || Date.now(),
    }
    for (const listener of this.listeners) listener(message)
  }

  private acceptInteraction(text: string): boolean {
    const approval = /^\/(approve|reject|同意|拒绝)\s+([a-f0-9]{8})$/i.exec(text)
    if (approval !== null) {
      const decision = approval[1]!.toLowerCase()
      this.finishInteraction(approval[2]!.toLowerCase(), decision === 'approve' || decision === '同意' ? 'allowed-once' : 'rejected')
      return true
    }
    const answer = /^\/answer\s+([a-f0-9]{8})\s+([\s\S]+)$/i.exec(text)
    if (answer !== null) {
      const id = answer[1]!.toLowerCase()
      const pending = this.interactions.get(id)
      if (pending?.kind !== 'question') return true
      const answers = answer[2]!.split('|').map((item) => item.trim())
      if (answers.length !== pending.count || answers.some((item) => item === '')) return true
      clearTimeout(pending.timer)
      if (pending.signal !== undefined && pending.onAbort !== undefined) pending.signal.removeEventListener('abort', pending.onAbort)
      this.interactions.delete(id)
      pending.resolve(answers)
      return true
    }
    return false
  }

  private finishInteraction(id: string, outcome: ApprovalOutcome): void {
    const pending = this.interactions.get(id)
    if (pending?.kind !== 'approval') return
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) pending.signal.removeEventListener('abort', pending.onAbort)
    this.interactions.delete(id)
    pending.resolve(outcome)
  }

  private rejectQuestion(id: string, error: Error): void {
    const pending = this.interactions.get(id)
    if (pending?.kind !== 'question') return
    clearTimeout(pending.timer)
    if (pending.signal !== undefined && pending.onAbort !== undefined) pending.signal.removeEventListener('abort', pending.onAbort)
    this.interactions.delete(id)
    pending.reject(error)
  }

  private cancelInteractions(): void {
    for (const [id, pending] of this.interactions) {
      clearTimeout(pending.timer)
      if (pending.signal !== undefined && pending.onAbort !== undefined) pending.signal.removeEventListener('abort', pending.onAbort)
      this.interactions.delete(id)
      if (pending.kind === 'approval') pending.resolve('cancelled')
      else pending.reject(new Error('通道已关闭'))
    }
  }

  private cancelBindingState(error: Error): void {
    this.qrWaiter?.reject(error)
    this.qrWaiter = undefined
    this.bindingTaskId = undefined
  }

  private requireOwner(userId: string): PersistedChannelBinding {
    const binding = this.options.persistence.load()
    if (binding === undefined || binding.ownerUserId !== userId) throw new Error('channel owner mismatch')
    return binding
  }

  private interactionId(): string {
    return randomUUID().replaceAll('-', '').slice(0, 8)
  }

  private remember(extId: string): void {
    this.seen.add(extId)
    while (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!)
  }
}
