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
import { rememberBounded } from './channel.js'
import { ChannelInteractions } from './channel-interactions.js'
import { unsetCredentialBestEffort } from './credentials.js'
import { splitMessageTextByBytes } from './editable-stream.js'
import { PairingCode } from './pairing.js'
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
/**
 * The SDK documents the streamed reply cap in BYTES
 * (`@wecom/aibot-node-sdk` README: 回复内容最长 20480 字节).  Counting UTF-16
 * code units instead let a ~6.9k-character Chinese answer (~20.7 KB of UTF-8)
 * look "under the limit" and be rejected by the platform.
 */
const WECOM_STREAM_BYTES = 20_480

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
  private readonly pairing = new PairingCode()
  private starting?: Promise<void>
  private generation = 0
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
    // Memoize the in-flight start: the guard above is checked before the awaits
    // below, so the automatic startup could race 连接/configure, build two
    // WSClient connections, and leave the first socket live and undisconnected —
    // every inbound message was then handled twice (duplicate turns/replies).
    //
    // `stop()` clears the memo, and the cleanup is identity-checked, so a
    // 断开 → 连接 pair during the handshake starts a real second attempt instead
    // of reusing the abandoned one (which would abort on its generation check and
    // leave 连接 reporting success with a dead channel).
    const run = this.doStart()
    this.starting = run
    try {
      return await run
    } finally {
      if (this.starting === run) this.starting = undefined
    }
  }

  private async doStart(): Promise<void> {
    const generation = this.generation
    const binding = this.options.persistence.load()
    if (!binding) { this.status = { state: 'idle', connected: false }; return }
    const botId = await this.options.credentials.resolve(this.options.botIdRef)
    const secret = await this.options.credentials.resolve(this.options.secretRef)
    if (!botId || !secret) {
      this.status = { state: 'idle', connected: false, error: '企业微信 Bot ID 或 Secret 缺失，请重新配置' }
      return
    }
    try {
      // stop() ran while we were awaiting credentials: do not connect behind
      // the operator's back (the previous socket would be overwritten unsafely).
      if (generation !== this.generation) return
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
      // Every listener pins this attempt's generation: a 断开 while a socket
      // event is in flight must not be undone by a late event re-marking the
      // channel connected (the "已连接但不响应" symptom).
      const isCurrent = (): boolean => generation === this.generation
      client.on('connected', () => { if (isCurrent()) this.status = { ...this.status, connected: true, error: undefined } })
      client.on('authenticated', () => {
        if (!isCurrent()) return
        this.status = binding.ownerUserId
          ? { state: 'bound', connected: true, boundUserId: binding.ownerUserId }
          : { state: 'awaiting-code', connected: true, code: this.pairCode ??= this.pairing.issue() }
      })
      client.on('reconnecting', (attempt) => {
        if (isCurrent()) this.status = { ...this.status, connected: false, error: `企业微信正在重连（第 ${attempt} 次）` }
      })
      client.on('disconnected', (reason) => { if (isCurrent()) this.status = { ...this.status, connected: false, error: reason } })
      client.on('error', (error) => { this.options.logger.warn('[wecom] websocket error', error); if (isCurrent()) this.status = { ...this.status, connected: false, error: String(error) } })
      // A leaked rejection here is fatal: the Harness installs a global
      // unhandledRejection handler that exits the whole process.
      client.on('message.text', (frame) => {
        void this.acceptFrame(frame).catch((error) => this.options.logger.warn('[wecom] inbound handling failed', error))
      })
      client.on('event.enter_chat', (frame) => {
        void client.replyWelcome(frame, { msgtype: 'text', text: { content: '你好！我是 DeepSeek Harness，可以直接发消息给我。' } }).catch((error) => this.options.logger.warn('[wecom] welcome failed', error))
      })
      const authenticated = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('企业微信 WebSocket 认证超时')), 15_000)
        timer.unref?.()
        client.once('authenticated', () => { clearTimeout(timer); resolve() })
        client.once('error', (error) => { clearTimeout(timer); reject(error) })
      })
      try {
        client.connect()
        await authenticated
      } catch (error) {
        client.disconnect()
        if (this.client === client) this.client = undefined
        this.status = { state: binding.ownerUserId ? 'bound' : 'idle', connected: false, boundUserId: binding.ownerUserId || undefined, error: String(error) }
        throw error
      }
      // stop() ran during the handshake: the SDK may still have delivered
      // `authenticated` (whose listener publishes connected:true), so drop this
      // attempt's socket and never claim a connection we no longer own.
      if (generation !== this.generation) {
        client.disconnect()
        if (this.client === client) this.client = undefined
        this.status = { ...this.status, connected: false }
        return
      }
    } finally {
      botId.value = ''
      secret.value = ''
    }
  }

  async stop(): Promise<void> {
    this.generation++
    // Drop the memo: a later start() must build a fresh attempt rather than
    // reuse one this stop() just invalidated.
    this.starting = undefined
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
    const chunks = splitMessageTextByBytes(text, WECOM_STREAM_BYTES)
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
    let failed = false
    const sendPlain = (value: string) => this.sendText(userId, value)
    const logger = this.options.logger
    const enqueue = (work: () => Promise<void>) => {
      queue = queue.then(work).catch((error) => {
        // Remember the failure: `enqueue` swallows every error, so `await queue`
        // below would otherwise always fulfil and finish() would report success
        // even when the terminal reply was rejected — the user was left on the
        // last partial stream and the answer was lost with only a warn log.
        failed = true
        this.options.logger.warn('[wecom] stream update failed', error)
      })
    }
    enqueue(() => client.replyStream(target, streamId, '正在思考中…', false).then(() => undefined))
    return {
      update: (text) => {
        if (closed) return
        const preview = splitMessageTextByBytes(text, WECOM_STREAM_BYTES)[0] ?? ''
        enqueue(() => client.replyStream(target, streamId, preview, false).then(() => undefined))
      },
      finish: async (text) => {
        if (closed) return
        closed = true
        const chunks = splitMessageTextByBytes(text || '处理完成。', WECOM_STREAM_BYTES)
        enqueue(() => client.replyStream(target, streamId, chunks[0] ?? '处理完成。', true).then(() => undefined))
        for (const chunk of chunks.slice(1)) enqueue(() => client.sendMessage(userId, { msgtype: 'markdown', markdown: { content: chunk } }).then(() => undefined))
        await queue
        if (failed) {
          // Deliver the answer as plain messages rather than leaving the user
          // with a partial stream and no reply at all.
          logger.warn('[wecom] streaming reply failed; resending the answer as plain messages')
          await sendPlain(text || '处理完成。').catch((sendError: unknown) => logger.warn('[wecom] plain fallback reply failed', sendError))
        }
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
  async cancelBinding(): Promise<void> { this.clearPairing(); if (this.status.state === 'awaiting-code') this.status = { ...this.status, state: 'idle', code: undefined } }
  async unbind(): Promise<void> {
    await this.stop()
    const removed = await Promise.all([
      unsetCredentialBestEffort(this.options.credentials, this.options.botIdRef),
      unsetCredentialBestEffort(this.options.credentials, this.options.secretRef),
    ])
    if (removed.includes(false)) {
      this.options.logger.warn('[wecom] credentials are environment-managed; binding revoked but the secrets stay in the launch environment')
    }
    await this.options.persistence.clear().catch(() => undefined)
    this.clearPairing()
    this.status = { state: 'idle', connected: false }
  }
  getStatus(): ChannelStatus { return { ...this.status } }
  onInbound(callback: (message: InboundTextMessage) => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback) }

  private async acceptFrame(frame: WsFrame<TextMessage>): Promise<void> {
    const body = frame.body
    if (!body || body.msgtype !== 'text' || !body.from?.userid) return
    const userId = String(body.from.userid)
    const text = String(body.text?.content ?? '').trim()
    const extId = String(body.msgid)
    const binding = this.options.persistence.load()
    if (!binding?.ownerUserId) {
      // Bounded, and only after the sender is known to be relevant: the entry
      // used to be inserted for ANY sender before this check, letting any
      // enterprise user grow the map for the whole process lifetime.
      if (this.pairCode !== undefined) {
        const verdict = this.pairing.check(text)
        if (verdict === 'match') await this.claimOwner(binding!, userId, frame)
        else if (verdict !== 'mismatch') this.refreshPairingCode()
      }
      return
    }
    if (userId !== binding.ownerUserId) return
    rememberBounded(this.targets, extId, frame)
    this.lastTarget.set(userId, frame)
    if (this.interactions.accept(text)) return
    if (!text) return
    const inbound: InboundTextMessage = { channel: this.kind, userId, extId, text, timestamp: Number(body.create_time) * 1000 || Date.now() }
    for (const listener of this.listeners) listener(inbound)
  }

  private async claimOwner(binding: PersistedChannelBinding, userId: string, frame: WsFrame<TextMessage>): Promise<void> {
    await this.options.persistence.save({ ...binding, ownerUserId: userId })
    this.clearPairing()
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
          // The listener must be removed on the normal (timer) path too, or a
          // 5-minute QR session accumulates ~100 listeners on one AbortSignal
          // (MaxListenersExceededWarning, and every closure stays reachable).
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve() }
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')) }
          const timer = setTimeout(done, WECOM_QR_POLL_MS)
          timer.unref?.()
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
  /** Republish a fresh pairing code through the status the settings panel polls. */
  private refreshPairingCode(): void {
    this.pairCode = this.pairing.issue()
    if (this.status.state === 'awaiting-code') this.status = { ...this.status, code: this.pairCode }
  }
  private clearPairing(): void { this.pairing.clear(); this.pairCode = undefined }
}
