import { randomInt } from 'node:crypto'
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk'
import type { TextMessage, WsFrame } from '@wecom/aibot-node-sdk'
import type {
  ApprovalOutcome,
  ApprovalPrompt,
  BridgeQuestion,
  ChannelAdapter,
  ChannelReplyStream,
  ChannelStatus,
  InboundTextMessage,
} from './channel.js'
import { ChannelInteractions } from './channel-interactions.js'
import { splitMessageText } from './editable-stream.js'
import type { ChannelPersistence, CredentialAccess, PersistedChannelBinding } from './sidecar-channel.js'

export interface WecomChannelOptions {
  readonly botIdRef: string
  readonly secretRef: string
  readonly credentials: CredentialAccess
  readonly persistence: ChannelPersistence
  readonly logger: { info(message: string, ...rest: unknown[]): void; warn(message: string, ...rest: unknown[]): void; error(message: string, ...rest: unknown[]): void }
  readonly wsUrl?: string
  readonly fetchImpl?: typeof fetch
}

const WECOM_QR_GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate'
const WECOM_QR_POLL_URL = 'https://work.weixin.qq.com/ai/qc/query_result'
const WECOM_QR_TTL_MS = 5 * 60_000
const WECOM_QR_POLL_MS = 3_000

/** 企业微信智能机器人官方 WebSocket 长连接适配器。 */
export class WecomChannelAdapter implements ChannelAdapter {
  readonly kind = 'wecom' as const
  private status: ChannelStatus = { state: 'idle', connected: false }
  private readonly listeners = new Set<(message: InboundTextMessage) => void>()
  private readonly targets = new Map<string, WsFrame<TextMessage>>()
  private readonly lastTarget = new Map<string, WsFrame<TextMessage>>()
  private readonly interactions: ChannelInteractions
  private client?: WSClient
  private pairCode?: string
  private registrationController?: AbortController
  private registrationTask?: Promise<void>

  constructor(private readonly options: WecomChannelOptions) {
    this.interactions = new ChannelInteractions(async (text) => {
      const owner = this.options.persistence.load()?.ownerUserId
      if (!owner) throw new Error('企业微信尚未完成配对')
      await this.sendText(owner, text)
    })
  }

  async configure(values: Readonly<Record<string, string>>): Promise<void> {
    const botId = values.botId?.trim() ?? ''
    const secret = values.secret?.trim() ?? ''
    if (!botId || !secret) throw new Error('请填写企业微信 Bot ID 和 Secret')
    await this.stop()
    await this.options.credentials.set(this.options.botIdRef, botId)
    await this.options.credentials.set(this.options.secretRef, secret)
    const previous = this.options.persistence.load()
    await this.options.persistence.save({
      accountId: botId,
      ownerUserId: previous?.accountId === botId ? previous.ownerUserId : '',
      baseUrl: 'wecom',
    })
    await this.start()
  }

  async start(): Promise<void> {
    if (this.client) return
    const binding = this.options.persistence.load()
    if (!binding) { this.status = { state: 'idle', connected: false }; return }
    const botId = await this.options.credentials.resolve(this.options.botIdRef)
    const secret = await this.options.credentials.resolve(this.options.secretRef)
    if (!botId || !secret) {
      this.status = { state: 'idle', connected: false, error: '企业微信 Bot ID 或 Secret 缺失，请重新配置' }
      return
    }
    const client = new WSClient({
      botId: botId.value,
      secret: secret.value,
      wsUrl: this.options.wsUrl,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 3,
      logger: {
        debug: (...args) => this.options.logger.info('[wecom] debug', ...args),
        info: (...args) => this.options.logger.info('[wecom]', ...args),
        warn: (...args) => this.options.logger.warn('[wecom]', ...args),
        error: (...args) => this.options.logger.error('[wecom]', ...args),
      },
    })
    this.client = client
    client.on('connected', () => { this.status = { ...this.status, connected: true, error: undefined } })
    client.on('authenticated', () => {
      this.status = binding.ownerUserId
        ? { state: 'bound', connected: true, boundUserId: binding.ownerUserId }
        : { state: 'awaiting-code', connected: true, code: this.pairCode ??= this.newPairCode() }
    })
    client.on('reconnecting', (attempt) => {
      this.status = { ...this.status, connected: false, error: `企业微信正在重连（第 ${attempt} 次）` }
    })
    client.on('disconnected', (reason) => { this.status = { ...this.status, connected: false, error: reason } })
    client.on('error', (error) => { this.options.logger.warn('[wecom] websocket error', error); this.status = { ...this.status, connected: false, error: String(error) } })
    client.on('message.text', (frame) => { void this.acceptFrame(frame) })
    client.on('event.enter_chat', (frame) => {
      void client.replyWelcome(frame, { msgtype: 'text', text: { content: '你好！我是 DeepSeek Harness，可以直接发消息给我。' } }).catch((error) => this.options.logger.warn('[wecom] welcome failed', error))
    })
    const authenticated = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('企业微信 WebSocket 认证超时')), 15_000)
      client.once('authenticated', () => { clearTimeout(timer); resolve() })
      client.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
    try {
      client.connect()
      await authenticated
    } catch (error) {
      client.disconnect()
      this.client = undefined
      this.status = { state: binding.ownerUserId ? 'bound' : 'idle', connected: false, boundUserId: binding.ownerUserId || undefined, error: String(error) }
      throw error
    } finally {
      botId.value = ''
      secret.value = ''
    }
  }

  async stop(): Promise<void> {
    this.registrationController?.abort()
    this.client?.disconnect()
    this.client = undefined
    this.status = { ...this.status, connected: false }
  }

  async dispose(): Promise<void> {
    await this.stop()
    this.interactions.cancel()
    this.listeners.clear(); this.targets.clear(); this.lastTarget.clear()
  }

  async sendText(userId: string, text: string, replyToId?: string): Promise<void> {
    this.requireOwner(userId)
    const client = this.requireClient()
    const target = (replyToId ? this.targets.get(replyToId) : undefined) ?? this.lastTarget.get(userId)
    const chunks = splitMessageText(text, 20_000)
    if (target) {
      for (const chunk of chunks) await client.reply(target, { msgtype: 'markdown', markdown: { content: chunk } })
      return
    }
    for (const chunk of chunks) await client.sendMessage(userId, { msgtype: 'markdown', markdown: { content: chunk } })
  }

  async sendTyping(userId: string): Promise<void> { this.requireOwner(userId) }

  async openReplyStream(userId: string, replyToId: string): Promise<ChannelReplyStream | undefined> {
    this.requireOwner(userId)
    const client = this.requireClient()
    const target = this.targets.get(replyToId) ?? this.lastTarget.get(userId)
    if (!target) return undefined
    const streamId = generateReqId('dsh')
    let queue = Promise.resolve()
    let closed = false
    const enqueue = (work: () => Promise<void>) => { queue = queue.then(work).catch((error) => this.options.logger.warn('[wecom] stream update failed', error)) }
    enqueue(() => client.replyStream(target, streamId, '正在思考中…', false).then(() => undefined))
    return {
      update: (text) => { if (!closed) enqueue(() => client.replyStream(target, streamId, text.slice(0, 20_480), false).then(() => undefined)) },
      finish: async (text) => {
        if (closed) return
        closed = true
        const chunks = splitMessageText(text || '处理完成。', 20_000)
        enqueue(() => client.replyStream(target, streamId, chunks[0] ?? '处理完成。', true).then(() => undefined))
        for (const chunk of chunks.slice(1)) enqueue(() => client.sendMessage(userId, { msgtype: 'markdown', markdown: { content: chunk } }).then(() => undefined))
        await queue
      },
      cancel: () => { closed = true },
    }
  }

  askApproval(userId: string, prompt: ApprovalPrompt, signal?: AbortSignal): Promise<ApprovalOutcome> { this.requireOwner(userId); return this.interactions.askApproval(prompt, signal) }
  askQuestion(userId: string, questions: ReadonlyArray<BridgeQuestion>, signal?: AbortSignal): Promise<string[]> { this.requireOwner(userId); return this.interactions.askQuestion(questions, signal) }

  async startBinding(): Promise<{ qrDataUrl: string; code?: string }> {
    await this.stop()
    this.registrationController?.abort()
    await this.registrationTask?.catch(() => undefined)
    const controller = new AbortController()
    this.registrationController = controller
    const fetchImpl = this.options.fetchImpl ?? fetch
    const started = await this.qrRequest(fetchImpl, WECOM_QR_GENERATE_URL, undefined, controller.signal)
    const scode = this.clean(started?.data?.scode)
    const verificationUrl = this.safeVerificationUrl(started?.data?.auth_url)
    if (!scode || !verificationUrl) throw new Error('企业微信扫码服务返回了无效二维码')
    this.status = { state: 'awaiting-code', connected: false, qrDataUrl: verificationUrl }
    const expiresAt = Date.now() + WECOM_QR_TTL_MS
    this.registrationTask = this.pollQr(scode, expiresAt, controller.signal).finally(() => {
      if (this.registrationController === controller) {
        this.registrationController = undefined
        this.registrationTask = undefined
      }
    })
    return { qrDataUrl: verificationUrl }
    // Kept below only as an unreachable compatibility guard for old builds.
    throw new Error('企业微信扫码创建机器人需要腾讯云或企业内部授权入口；请先在企业微信创建 API 模式智能机器人并选择长连接，再填写 Bot ID 和 Secret')
  }
  async submitCode(): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: '请在企业微信私聊机器人发送配对码' } }
  async cancelBinding(): Promise<void> { this.pairCode = undefined; if (this.status.state === 'awaiting-code') this.status = { ...this.status, state: 'idle', code: undefined } }
  async unbind(): Promise<void> { await this.stop(); await this.options.credentials.unset(this.options.botIdRef); await this.options.credentials.unset(this.options.secretRef); await this.options.persistence.clear(); this.pairCode = undefined; this.status = { state: 'idle', connected: false } }
  getStatus(): ChannelStatus { return { ...this.status } }
  onInbound(callback: (message: InboundTextMessage) => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback) }

  private async acceptFrame(frame: WsFrame<TextMessage>): Promise<void> {
    const body = frame.body
    if (!body || body.msgtype !== 'text' || !body.from?.userid) return
    const userId = String(body.from.userid)
    const text = String(body.text?.content ?? '').trim()
    const extId = String(body.msgid)
    this.targets.set(extId, frame); this.lastTarget.set(userId, frame)
    const binding = this.options.persistence.load()
    if (!binding?.ownerUserId) {
      if (this.pairCode && text === this.pairCode) await this.claimOwner(binding!, userId, frame)
      return
    }
    if (userId !== binding.ownerUserId) return
    if (this.interactions.accept(text)) return
    if (!text) return
    const inbound: InboundTextMessage = { channel: this.kind, userId, extId, text, timestamp: Number(body.create_time) * 1000 || Date.now() }
    for (const listener of this.listeners) listener(inbound)
  }

  private async claimOwner(binding: PersistedChannelBinding, userId: string, frame: WsFrame<TextMessage>): Promise<void> {
    await this.options.persistence.save({ ...binding, ownerUserId: userId })
    this.pairCode = undefined
    this.status = { state: 'bound', connected: true, boundUserId: userId }
    await this.requireClient().reply(frame, { msgtype: 'markdown', markdown: { content: '✅ 企业微信已安全绑定，现在可以直接交给 DeepSeek Harness 执行任务。' } })
  }

  private requireClient(): WSClient { if (!this.client) throw new Error('企业微信尚未连接'); return this.client }
  private requireOwner(userId: string): void { if (this.options.persistence.load()?.ownerUserId !== userId) throw new Error('企业微信 owner mismatch') }
  private clean(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  private safeVerificationUrl(value: unknown): string | undefined {
    const raw = this.clean(value)
    if (!raw) return undefined
    try {
      const url = new URL(raw)
      return url.protocol === 'https:' && url.hostname === 'work.weixin.qq.com' && (!url.port || url.port === '443') ? url.href : undefined
    } catch { return undefined }
  }
  private async qrRequest(fetchImpl: typeof fetch, baseUrl: string, scode: string | undefined, signal: AbortSignal): Promise<any> {
    const url = new URL(baseUrl)
    if (scode) url.searchParams.set('scode', scode)
    else {
      url.searchParams.set('source', 'deepseek-harness')
      url.searchParams.set('plat', process.platform === 'win32' ? '2' : process.platform === 'linux' ? '3' : '1')
    }
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`企业微信扫码服务 HTTP ${response.status}`)
    return await response.json()
  }
  private async pollQr(scode: string, expiresAt: number, signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted && Date.now() < expiresAt) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, WECOM_QR_POLL_MS)
          const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')) }
          signal.addEventListener('abort', abort, { once: true })
        })
        if (signal.aborted) return
        const body = await this.qrRequest(this.options.fetchImpl ?? fetch, WECOM_QR_POLL_URL, scode, signal)
        const state = this.clean(body?.data?.status)?.toLowerCase()
        if (state === 'expired' || state === 'timeout') { this.status = { state: 'idle', connected: false, error: '企业微信二维码已过期，请重新生成' }; return }
        if (state === 'fail' || state === 'failed' || state === 'error') { this.status = { state: 'idle', connected: false, error: '企业微信扫码授权失败，请重新生成' }; return }
        if (state !== 'success') continue
        const botId = this.clean(body?.data?.bot_info?.botid)
        const secret = this.clean(body?.data?.bot_info?.secret)
        if (!botId || !secret) throw new Error('企业微信扫码结果缺少 Bot ID 或 Secret')
        const previous = this.options.persistence.load()
        await this.options.credentials.set(this.options.botIdRef, botId)
        await this.options.credentials.set(this.options.secretRef, secret)
        await this.options.persistence.save({ accountId: botId, ownerUserId: previous?.accountId === botId ? previous.ownerUserId : '', baseUrl: 'wecom' })
        await this.start()
        return
      }
      if (!signal.aborted) this.status = { state: 'idle', connected: false, error: '企业微信二维码已过期，请重新生成' }
    } catch (error) {
      if (!signal.aborted) { this.status = { state: 'idle', connected: false, error: String(error) }; this.options.logger.warn('[wecom] QR authorization failed', error) }
    }
  }
  private newPairCode(): string { return String(randomInt(100000, 1_000_000)) }
}
