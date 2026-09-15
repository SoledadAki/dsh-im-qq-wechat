import * as lark from '@larksuiteoapi/node-sdk'
import type { ApprovalOutcome, ApprovalPrompt, BridgeQuestion, ChannelAdapter, ChannelReplyStream, ChannelStatus, InboundTextMessage } from './channel.js'
import { rememberBounded } from './channel.js'
import { ChannelInteractions } from './channel-interactions.js'
import { unsetCredentialBestEffort } from './credentials.js'
import { splitMessageText, truncateMessageText } from './editable-stream.js'
import { PairingCode } from './pairing.js'
import type { ChannelPersistence, CredentialAccess, PersistedChannelBinding } from './sidecar-channel.js'

interface FeishuTarget { chatId: string; messageId: string }

export interface FeishuChannelOptions {
  readonly appIdRef: string
  readonly appSecretRef: string
  readonly credentials: CredentialAccess
  readonly persistence: ChannelPersistence
  readonly logger: { info(message: string, ...rest: unknown[]): void; warn(message: string, ...rest: unknown[]): void; error(message: string, ...rest: unknown[]): void }
  readonly fetchImpl?: typeof fetch
}

function assertSuccess(operation: string, response: any): any {
  if (response?.code && response.code !== 0) throw new Error(`${operation}: ${response.msg || response.code}`)
  return response
}

async function verifyApp(appId: string, appSecret: string, domain: string, fetchImpl: typeof fetch): Promise<void> {
  if (!/^cli_[A-Za-z0-9]+$/.test(appId) || !appSecret) throw new Error('飞书 App ID 或 App Secret 格式无效')
  const origin = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const auth = await fetchImpl(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(15_000) })
  const body = await auth.json().catch(() => undefined) as any
  if (!auth.ok || body?.code !== 0 || !body.tenant_access_token) throw new Error(`飞书凭据验证失败：${body?.msg ?? auth.status}`)
}

/** Feishu WebSocket + CardKit adapter, adapted from xmanrui/dsh-im (MIT). */
export class FeishuChannelAdapter implements ChannelAdapter {
  readonly kind = 'feishu' as const
  private status: ChannelStatus = { state: 'idle', connected: false }
  private readonly listeners = new Set<(message: InboundTextMessage) => void>()
  private readonly targets = new Map<string, FeishuTarget>()
  private readonly lastTarget = new Map<string, FeishuTarget>()
  private readonly interactions: ChannelInteractions
  private client?: any
  private ws?: any
  private pairCode?: string
  private readonly pairing = new PairingCode()
  private starting?: Promise<void>
  private generation = 0
  private registrationController?: AbortController
  private registrationTask?: Promise<void>
  private registrationQrReject?: (error: Error) => void

  constructor(private readonly options: FeishuChannelOptions) {
    this.interactions = new ChannelInteractions(async (text) => {
      const owner = this.options.persistence.load()?.ownerUserId
      if (!owner) throw new Error('飞书尚未配对主人')
      await this.sendText(owner, text)
    })
  }

  async configure(values: Readonly<Record<string, string>>): Promise<void> {
    const appId = values.appId?.trim() ?? ''
    const appSecret = values.appSecret?.trim() ?? ''
    const domain = values.domain === 'lark' ? 'lark' : 'feishu'
    await verifyApp(appId, appSecret, domain, this.options.fetchImpl ?? fetch)
    await this.stop()
    await this.options.credentials.set(this.options.appIdRef, appId)
    await this.options.credentials.set(this.options.appSecretRef, appSecret)
    const previous = this.options.persistence.load()
    await this.options.persistence.save({ accountId: appId, ownerUserId: previous?.accountId === appId ? previous.ownerUserId : '', baseUrl: domain })
    await this.start()
  }

  async start(): Promise<void> {
    if (this.ws) return
    // Memoize the in-flight start.  The guard above is checked before the awaits
    // in doStart(), so a second caller (automatic startup racing the panel's
    // 连接, or a re-configure) used to build a second WSClient: the first socket
    // was overwritten and never closed, and both dispatchers delivered every
    // inbound event — one user message produced two agent turns and two replies.
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
    const [appIdValue, secretValue] = await Promise.all([this.options.credentials.resolve(this.options.appIdRef), this.options.credentials.resolve(this.options.appSecretRef)])
    if (!appIdValue || !secretValue) { this.status = { state: 'idle', connected: false, error: '飞书凭据已丢失，请重新配置' }; return }
    const domain = binding.baseUrl === 'lark' ? 'lark' : 'feishu'
    // Hoisted so teardown can target exactly what this attempt built: after an
    // interleaved stop(), a newer start() may already own `this.ws`/`this.client`.
    let builtClient: any
    let builtWs: any
    const teardownAttempt = (): void => {
      if (this.ws === builtWs) this.ws = undefined
      if (this.client === builtClient) this.client = undefined
      try { builtWs?.close({ force: true }) } catch { /* the socket may already be gone */ }
    }
    try {
      await verifyApp(appIdValue.value, secretValue.value, domain, this.options.fetchImpl ?? fetch)
      // stop() ran while we were awaiting: do not reconnect behind the operator's back.
      if (generation !== this.generation) return
      const config = { appId: appIdValue.value, appSecret: secretValue.value, domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu }
      builtClient = new lark.Client(config)
      this.client = builtClient
      const dispatcher = new lark.EventDispatcher({}).register({ 'im.message.receive_v1': (event: any) => {
        // Fire-and-forget must never leak a rejection: the Harness installs a
        // global unhandledRejection handler that exits the whole process.
        void this.acceptEvent(event).catch((error) => this.options.logger.warn('[feishu] inbound handling failed', error))
        return {}
      } })
      let readyResolve!: () => void
      let readyReject!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
      // Attach a handler immediately so an abandoned handshake cannot surface as
      // an unhandled rejection when WSClient construction throws synchronously.
      void ready.catch(() => undefined)
      const timer = setTimeout(() => readyReject(new Error('飞书长连接握手超时')), 15_000)
      timer.unref?.()
      // The reconnect hooks pin this attempt's generation so a 断开 cannot be
      // undone by a late socket event re-marking the channel connected.
      const attemptWs = new lark.WSClient({ ...config, loggerLevel: lark.LoggerLevel.info, onReady: () => readyResolve(), onError: (error: Error) => readyReject(error), onReconnecting: () => { if (generation === this.generation) this.status = { ...this.status, connected: false } }, onReconnected: () => { if (generation === this.generation) this.status = { ...this.status, connected: true, error: undefined } } })
      builtWs = attemptWs
      this.ws = attemptWs
      void attemptWs.start({ eventDispatcher: dispatcher }).catch((error: Error) => readyReject(error))
      await ready.finally(() => clearTimeout(timer))
      // stop() ran during the handshake: close only this attempt's socket rather
      // than publishing a connected status the operator already revoked.
      if (generation !== this.generation) { teardownAttempt(); return }
      if (!binding.ownerUserId) this.refreshPairingCode()
      this.status = binding.ownerUserId
        ? { state: 'bound', connected: true, boundUserId: binding.ownerUserId }
        : { state: 'awaiting-code', connected: true, code: this.pairCode }
    } catch (error) {
      teardownAttempt()
      this.status = { state: binding.ownerUserId ? 'bound' : 'idle', connected: false, boundUserId: binding.ownerUserId || undefined, error: String(error) }
      throw error
    } finally { appIdValue.value = ''; secretValue.value = '' }
  }

  async stop(): Promise<void> {
    this.generation++
    // Drop the memo: a later start() must build a fresh attempt rather than
    // reuse one this stop() just invalidated.
    this.starting = undefined
    this.registrationQrReject?.(new Error('飞书扫码授权已取消'))
    this.registrationQrReject = undefined
    this.registrationController?.abort()
    this.registrationController = undefined
    this.registrationTask = undefined
    this.ws?.close({ force: true }); this.ws = undefined; this.client = undefined
    this.status = { ...this.status, connected: false }
  }
  async dispose(): Promise<void> { await this.stop(); this.interactions.cancel(); this.listeners.clear(); this.targets.clear(); this.lastTarget.clear() }

  async sendText(userId: string, text: string, replyToId?: string): Promise<void> {
    this.requireOwner(userId)
    const target = (replyToId ? this.targets.get(replyToId) : undefined) ?? this.lastTarget.get(userId)
    if (!target) throw new Error('没有可用的飞书会话地址')
    for (const [index, chunk] of splitMessageText(text, 9000).entries()) {
      const data = { msg_type: 'text', content: JSON.stringify({ text: chunk }) }
      const response = index === 0 && replyToId
        ? await this.requireClient().im.v1.message.reply({ path: { message_id: target.messageId }, data })
        : await this.requireClient().im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: target.chatId, ...data } })
      assertSuccess('飞书发送消息失败', response)
    }
  }

  async sendTyping(userId: string, replyToId?: string): Promise<void> {
    this.requireOwner(userId)
    // Feishu has no Telegram-style typing API. openReplyStream immediately
    // publishes a streaming card and an OnIt reaction as the native indicator.
    void replyToId
  }

  async openReplyStream(userId: string, replyToId: string): Promise<ChannelReplyStream | undefined> {
    this.requireOwner(userId)
    const target = this.targets.get(replyToId) ?? this.lastTarget.get(userId)
    if (!target) return undefined
    const client = this.requireClient()
    const card = { schema: '2.0', config: { streaming_mode: true, summary: { content: '正在生成…' }, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' } }, body: { elements: [{ tag: 'markdown', element_id: 'stream_md', content: '正在思考…' }] } }
    const created = assertSuccess('飞书创建流式卡片失败', await client.cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(card) } }))
    const cardId = created?.data?.card_id
    if (!cardId) throw new Error('飞书未返回 card_id')
    const sent = assertSuccess('飞书发送流式卡片失败', await client.im.v1.message.reply({ path: { message_id: target.messageId }, data: { msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }) } }))
    const reaction = await this.addReaction(target.messageId, 'OnIt').catch(() => undefined)
    const removeReaction = (reactionId: string) => this.removeReaction(target.messageId, reactionId)
    const sendRemainder = (text: string) => this.sendText(userId, text)
    const sendWholeReply = (text: string) => this.sendText(userId, text)
    // `finish`/`cancel` are object-literal shorthand methods, so `this` inside
    // them is the stream object — capture the logger from the adapter scope.
    const logger = this.options.logger
    let sequence = 0
    let pending = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let chain = Promise.resolve()
    let closed = false
    let failed = false
    const setContent = (content: string): void => {
      const next = truncateMessageText(content, 28_000)
      // `.catch` terminates the chain.  Without it a single transient 429/500
      // left `chain` rejected forever: every later update silently no-opped, and
      // finish()'s `await chain` threw *before* closing the card and before
      // sending the remaining chunks — the answer was lost and the card stayed
      // on 正在生成….  A rejection reaching cancel() was also unhandled, which
      // the Harness turns into a fatal process exit.
      chain = chain.then(async () => {
        if (failed) return
        assertSuccess('飞书流式更新失败', await client.cardkit.v1.cardElement.content({ path: { card_id: cardId, element_id: 'stream_md' }, data: { content: next || '…', sequence: ++sequence, uuid: `content_${cardId}_${sequence}` } }))
      }).catch((error) => {
        failed = true
        this.options.logger.warn('[feishu] streaming card update failed', error)
      })
    }
    const flush = (): void => { if (!pending || closed) return; const text = pending; pending = ''; setContent(text) }
    return {
      update(text) { if (closed || !text.trim()) return; pending = text; if (!timer) { timer = setTimeout(() => { timer = undefined; flush() }, 800); timer.unref?.() } },
      async finish(text) {
        if (closed) return
        const chunks = splitMessageText(text, 28_000)
        if (timer) clearTimeout(timer); timer = undefined; pending = ''; setContent(chunks[0] ?? '处理完成。'); closed = true
        await chain
        let cardClosed = false
        try {
          // Close the card even when an earlier update failed, otherwise it keeps
          // animating 正在生成… forever while the answer arrives elsewhere.
          assertSuccess('飞书结束流式卡片失败', await client.cardkit.v1.card.settings({ path: { card_id: cardId }, data: { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: truncateMessageText(text.replace(/\s+/g, ' '), 50) || '回答完成' } } }), sequence: ++sequence, uuid: `settings_${cardId}_${sequence}` } }))
          cardClosed = true
        } catch (error) {
          logger.warn('[feishu] streaming card could not be closed', error)
        }
        if (failed || !cardClosed) {
          // Either the card content is incomplete or the card could not be
          // finalised: deliver the whole answer as plain messages.
          logger.warn('[feishu] streaming card unusable; sending the answer as plain messages')
          await sendWholeReply(text).catch((sendError: unknown) => logger.warn('[feishu] plain fallback reply failed', sendError))
          if (reaction) await removeReaction(reaction).catch(() => undefined)
          return
        }
        if (reaction) await removeReaction(reaction).catch(() => undefined)
        for (const chunk of chunks.slice(1)) await sendRemainder(chunk)
      },
      async cancel() { closed = true; if (timer) clearTimeout(timer); if (reaction) await removeReaction(reaction).catch(() => undefined); if (sent?.data?.message_id) await client.im.v1.message.delete({ path: { message_id: sent.data.message_id } }).catch(() => undefined) },
    }
  }

  askApproval(userId: string, prompt: ApprovalPrompt, signal?: AbortSignal): Promise<ApprovalOutcome> { this.requireOwner(userId); return this.interactions.askApproval(prompt, signal) }
  askQuestion(userId: string, questions: ReadonlyArray<BridgeQuestion>, signal?: AbortSignal): Promise<string[]> { this.requireOwner(userId); return this.interactions.askQuestion(questions, signal) }
  async startBinding(): Promise<{ qrDataUrl: string; code?: string }> {
    if (this.registrationController !== undefined) {
      if (this.status.qrDataUrl) return { qrDataUrl: this.status.qrDataUrl }
      throw new Error('飞书扫码授权正在进行中')
    }
    await this.stop()
    const controller = new AbortController()
    this.registrationController = controller
    let resolveQr!: (value: { qrDataUrl: string }) => void
    let rejectQr!: (error: Error) => void
    const qr = new Promise<{ qrDataUrl: string }>((resolve, reject) => {
      resolveQr = resolve
      rejectQr = reject
      this.registrationQrReject = reject
    })
    this.status = { state: 'awaiting-code', connected: false }
    this.registrationTask = lark.registerApp({
      source: 'dsh-im-qq-wechat',
      signal: controller.signal,
      createOnly: true,
      appPreset: { name: 'DeepSeek Harness', desc: 'DeepSeek Harness 即时通信机器人' },
      addons: {
        scopes: { tenant: ['im:message', 'im:message:send_as_bot', 'im:resource'] },
        events: { items: { tenant: ['im.message.receive_v1'] } },
      },
      onQRCodeReady: ({ url }: { url: string }) => {
        this.status = { state: 'awaiting-code', connected: false, qrDataUrl: url }
        resolveQr({ qrDataUrl: url })
      },
      onStatusChange: ({ status, interval }: { status: string; interval?: number }) => {
        if (status === 'slow_down') this.options.logger.info(`[qq-weixin] 飞书扫码授权请求频率降低${interval ? `，轮询间隔 ${interval}s` : ''}`)
      },
    }).then(async (result) => {
      if (controller.signal.aborted) return
      const domain = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu'
      await verifyApp(result.client_id, result.client_secret, domain, this.options.fetchImpl ?? fetch)
      await this.options.credentials.set(this.options.appIdRef, result.client_id)
      await this.options.credentials.set(this.options.appSecretRef, result.client_secret)
      await this.options.persistence.save({ accountId: result.client_id, ownerUserId: result.user_info?.open_id ?? '', baseUrl: domain })
      await this.start()
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.status = { state: 'idle', connected: false, error: `飞书扫码授权失败：${failure.message}` }
        rejectQr(failure)
      }
    }).finally(() => {
      if (this.registrationController === controller) {
        this.registrationController = undefined
        this.registrationTask = undefined
        this.registrationQrReject = undefined
      }
    })
    return await qr
  }
  async submitCode(): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: '请在飞书私聊中发送配对码' } }
  async cancelBinding(): Promise<void> {
    this.registrationQrReject?.(new Error('飞书扫码授权已取消'))
    this.registrationQrReject = undefined
    this.registrationController?.abort()
    this.registrationController = undefined
    this.registrationTask = undefined
    this.refreshPairingCode()
    if (this.status.state === 'awaiting-code') this.status = { state: 'idle', connected: Boolean(this.ws) }
  }
  async unbind(): Promise<void> {
    await this.stop()
    const removed = await Promise.all([
      unsetCredentialBestEffort(this.options.credentials, this.options.appIdRef),
      unsetCredentialBestEffort(this.options.credentials, this.options.appSecretRef),
    ])
    if (removed.includes(false)) {
      this.options.logger.warn('[feishu] credentials are environment-managed; binding revoked but the secrets stay in the launch environment')
    }
    await this.options.persistence.clear().catch(() => undefined)
    this.clearPairing()
    this.status = { state: 'idle', connected: false }
  }
  getStatus(): ChannelStatus { return { ...this.status } }
  onInbound(callback: (message: InboundTextMessage) => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback) }

  private async acceptEvent(event: any): Promise<void> {
    if (event?.sender?.sender_type === 'bot' || event?.message?.message_type !== 'text') return
    let body: any
    try { body = JSON.parse(event.message.content) } catch { return }
    let text = String(body?.text ?? '')
    for (const mention of event.message.mentions ?? []) if (mention?.key) text = text.replaceAll(mention.key, '')
    text = text.trim()
    const userId = String(event?.sender?.sender_id?.open_id ?? '')
    const target = { chatId: String(event.message.chat_id ?? ''), messageId: String(event.message.message_id ?? '') }
    if (!userId || !target.chatId || !target.messageId) return
    const binding = this.options.persistence.load()
    if (!binding?.ownerUserId) {
      if (event.message.chat_type === 'p2p' && this.pairCode !== undefined) {
        const verdict = this.pairing.check(text)
        if (verdict === 'match') await this.claimOwner(binding!, userId, target)
        else if (verdict !== 'mismatch') this.refreshPairingCode()
      }
      return
    }
    if (userId !== binding.ownerUserId) return
    if (event.message.chat_type !== 'p2p' && !(event.message.mentions?.length > 0)) return
    const extId = target.messageId
    rememberBounded(this.targets, extId, target); this.lastTarget.set(userId, target)
    if (this.interactions.accept(text)) return
    if (!text) { await this.sendText(userId, '当前仅支持文本消息。', extId); return }
    const inbound: InboundTextMessage = { channel: this.kind, userId, extId, text, timestamp: Number(event.message.create_time) || Date.now() }
    for (const listener of this.listeners) listener(inbound)
  }

  private async claimOwner(binding: PersistedChannelBinding, userId: string, target: FeishuTarget): Promise<void> {
    await this.options.persistence.save({ ...binding, ownerUserId: userId }); this.lastTarget.set(userId, target); this.clearPairing()
    this.status = { state: 'bound', connected: true, boundUserId: userId }
    await this.sendText(userId, '✅ 飞书已安全绑定，现在可以直接给 DeepSeek Harness 发任务。', target.messageId)
  }
  private requireClient(): any { if (!this.client) throw new Error('飞书未连接'); return this.client }
  private requireOwner(userId: string): void { if (this.options.persistence.load()?.ownerUserId !== userId) throw new Error('Feishu owner mismatch') }
  private async addReaction(messageId: string, emoji: string): Promise<string> { const response = assertSuccess('飞书添加状态失败', await this.requireClient().im.v1.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } })); if (!response?.data?.reaction_id) throw new Error('飞书未返回 reaction_id'); return response.data.reaction_id }
  private async removeReaction(messageId: string, reactionId: string): Promise<void> { assertSuccess('飞书移除状态失败', await this.requireClient().im.v1.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } })) }
  /** Republish a fresh pairing code through the status the settings panel polls. */
  private refreshPairingCode(): void {
    this.pairCode = this.pairing.issue()
    if (this.status.state === 'awaiting-code') this.status = { ...this.status, code: this.pairCode }
  }
  private clearPairing(): void { this.pairing.clear(); this.pairCode = undefined }
}
