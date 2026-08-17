import { randomInt } from 'node:crypto'
import type { ApprovalOutcome, ApprovalPrompt, BridgeQuestion, ChannelAdapter, ChannelReplyStream, ChannelStatus, InboundTextMessage } from './channel.js'
import { ChannelInteractions } from './channel-interactions.js'
import { createEditableMessageStream, splitMessageText } from './editable-stream.js'
import type { ChannelPersistence, CredentialAccess, PersistedChannelBinding } from './sidecar-channel.js'
import { TelegramApi } from './telegram-api.js'

interface Target { chatId: string | number; replyToMessageId?: number; messageThreadId?: number }

export interface TelegramChannelOptions {
  readonly tokenRef: string
  readonly credentials: CredentialAccess
  readonly persistence: ChannelPersistence
  readonly logger: { info(message: string, ...rest: unknown[]): void; warn(message: string, ...rest: unknown[]): void; error(message: string, ...rest: unknown[]): void }
  readonly createApi?: (token: string) => TelegramApi
}

/** Telegram Bot API long-poll adapter, adapted from xmanrui/dsh-im (MIT). */
export class TelegramChannelAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const
  private status: ChannelStatus = { state: 'idle', connected: false }
  private readonly listeners = new Set<(message: InboundTextMessage) => void>()
  private readonly targets = new Map<string, Target>()
  private readonly lastTarget = new Map<string, Target>()
  private readonly interactions: ChannelInteractions
  private controller?: AbortController
  private api?: TelegramApi
  private bot?: { id: string; username?: string }
  private pairCode?: string
  private cursor?: number

  constructor(private readonly options: TelegramChannelOptions) {
    this.interactions = new ChannelInteractions(async (text) => {
      const owner = this.options.persistence.load()?.ownerUserId
      if (!owner) throw new Error('Telegram 尚未配对主人')
      await this.sendText(owner, text)
    })
  }

  async configure(values: Readonly<Record<string, string>>): Promise<void> {
    const token = values.token?.trim() ?? ''
    const api = (this.options.createApi ?? ((value) => new TelegramApi(value)))(token)
    const bot = await api.getMe()
    if (!bot?.id || bot.is_bot !== true) throw new Error('Token 不属于 Telegram 机器人')
    const webhook = await api.getWebhookInfo()
    if (webhook?.url) throw new Error('该机器人已配置 Webhook，请先移除 Webhook')
    await this.stop()
    await this.options.credentials.set(this.options.tokenRef, token)
    const previous = this.options.persistence.load()
    await this.options.persistence.save({ accountId: String(bot.id), ownerUserId: previous?.accountId === String(bot.id) ? previous.ownerUserId : '', cursor: previous?.accountId === String(bot.id) ? previous.cursor : undefined })
    await this.start()
  }

  async start(): Promise<void> {
    if (this.controller) return
    const binding = this.options.persistence.load()
    if (!binding) { this.status = { state: 'idle', connected: false }; return }
    const resolved = await this.options.credentials.resolve(this.options.tokenRef)
    if (!resolved) { this.status = { state: 'idle', connected: false, error: 'Telegram Token 已丢失，请重新配置' }; return }
    const controller = new AbortController()
    try {
      const api = (this.options.createApi ?? ((value) => new TelegramApi(value)))(resolved.value)
      const bot = await api.getMe(controller.signal)
      if (String(bot?.id ?? '') !== binding.accountId) throw new Error('Telegram Token 与保存的机器人不匹配')
      const webhook = await api.getWebhookInfo(controller.signal)
      if (webhook?.url) throw new Error('该机器人已配置 Webhook，请先移除 Webhook')
      this.controller = controller
      this.api = api
      this.bot = { id: String(bot.id), username: typeof bot.username === 'string' ? bot.username : undefined }
      this.cursor = binding.cursor
      if (this.cursor === undefined) {
        const latest = await api.getUpdates(-1, controller.signal, 0)
        this.cursor = latest.length ? Number(latest.at(-1).update_id) + 1 : 0
        await this.persistCursor()
      }
      if (!binding.ownerUserId) this.pairCode = this.newPairCode()
      this.status = binding.ownerUserId
        ? { state: 'bound', connected: true, boundUserId: binding.ownerUserId }
        : { state: 'awaiting-code', connected: true, code: this.pairCode }
      void this.poll(controller.signal)
    } catch (error) {
      controller.abort()
      this.controller = undefined
      this.api = undefined
      this.bot = undefined
      this.status = { state: binding.ownerUserId ? 'bound' : 'idle', connected: false, boundUserId: binding.ownerUserId || undefined, error: String(error) }
      throw error
    } finally { resolved.value = '' }
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    this.controller = undefined
    this.api = undefined
    this.status = { ...this.status, connected: false }
  }

  async dispose(): Promise<void> { await this.stop(); this.interactions.cancel(); this.listeners.clear(); this.targets.clear() }

  async sendText(userId: string, text: string, replyToId?: string): Promise<void> {
    this.requireOwner(userId)
    const api = this.requireApi()
    const target = (replyToId ? this.targets.get(replyToId) : undefined) ?? this.lastTarget.get(userId)
    if (!target) throw new Error('没有可用的 Telegram 会话地址')
    const chunks = splitMessageText(text, 4000)
    for (const [index, chunk] of chunks.entries()) await api.sendMessage({ ...target, text: chunk, replyToMessageId: index === 0 ? target.replyToMessageId : undefined, signal: this.controller?.signal })
  }

  async sendTyping(userId: string, replyToId?: string): Promise<void> {
    this.requireOwner(userId)
    const target = (replyToId ? this.targets.get(replyToId) : undefined) ?? this.lastTarget.get(userId)
    if (target) await this.requireApi().sendChatAction(target.chatId, target.messageThreadId, this.controller?.signal)
  }

  async openReplyStream(userId: string, replyToId: string): Promise<ChannelReplyStream | undefined> {
    this.requireOwner(userId)
    const target = this.targets.get(replyToId) ?? this.lastTarget.get(userId)
    if (!target) return undefined
    const api = this.requireApi()
    return createEditableMessageStream({
      limit: 4000,
      create: async (text) => String((await api.sendMessage({ ...target, text, signal: this.controller?.signal })).message_id),
      edit: (id, text) => api.editMessageText(target.chatId, Number(id), text, this.controller?.signal),
      sendRemainder: (text) => api.sendMessage({ chatId: target.chatId, messageThreadId: target.messageThreadId, text, signal: this.controller?.signal }),
      logger: this.options.logger,
    })
  }

  askApproval(userId: string, prompt: ApprovalPrompt, signal?: AbortSignal): Promise<ApprovalOutcome> { this.requireOwner(userId); return this.interactions.askApproval(prompt, signal) }
  askQuestion(userId: string, questions: ReadonlyArray<BridgeQuestion>, signal?: AbortSignal): Promise<string[]> { this.requireOwner(userId); return this.interactions.askQuestion(questions, signal) }
  async startBinding(): Promise<{ qrDataUrl: string; code?: string }> { throw new Error('Telegram 请填写 Bot Token 后，通过私聊配对码绑定') }
  async submitCode(): Promise<{ ok: boolean; error?: string }> { return { ok: false, error: '请在 Telegram 私聊中发送配对码' } }
  async cancelBinding(): Promise<void> { this.pairCode = this.newPairCode(); if (this.status.state === 'awaiting-code') this.status = { ...this.status, code: this.pairCode } }
  async unbind(): Promise<void> { await this.stop(); await this.options.credentials.unset(this.options.tokenRef); await this.options.persistence.clear(); this.pairCode = undefined; this.status = { state: 'idle', connected: false } }
  getStatus(): ChannelStatus { return { ...this.status } }
  onInbound(callback: (message: InboundTextMessage) => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback) }

  private async poll(signal: AbortSignal): Promise<void> {
    const api = this.requireApi()
    let failures = 0
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates(this.cursor, signal)
        for (const update of updates) {
          this.cursor = Number(update.update_id) + 1
          await this.acceptUpdate(update)
        }
        if (updates.length) await this.persistCursor()
        failures = 0
        if (!this.status.connected) this.status = { ...this.status, connected: true, error: undefined }
      } catch (error) {
        if (signal.aborted) return
        failures++
        this.status = { ...this.status, connected: false, error: `Telegram 正在重连：${String(error)}` }
        this.options.logger.warn('[telegram] polling interrupted; retrying', error)
        await new Promise<void>((resolve) => {
          const done = () => { signal.removeEventListener('abort', onAbort); resolve() }
          const timer = setTimeout(done, Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)))
          const onAbort = () => { clearTimeout(timer); done() }
          timer.unref?.()
          signal.addEventListener('abort', onAbort, { once: true })
        })
      }
    }
  }

  private async persistCursor(): Promise<void> {
    const binding = this.options.persistence.load()
    if (binding && this.cursor !== undefined) await this.options.persistence.save({ ...binding, cursor: this.cursor })
  }

  private async acceptUpdate(update: any): Promise<void> {
    const message = update?.message
    if (!Number.isSafeInteger(update?.update_id) || !message?.chat || !message?.from || !Number.isSafeInteger(message.message_id)) return
    if (message.from.is_bot || !['private', 'group', 'supergroup'].includes(message.chat.type)) return
    const userId = String(message.from.id)
    const text = this.withoutMention(String(message.text ?? message.caption ?? '')).trim()
    const target: Target = { chatId: message.chat.id, replyToMessageId: message.message_id, messageThreadId: Number.isSafeInteger(message.message_thread_id) ? message.message_thread_id : undefined }
    const binding = this.options.persistence.load()
    if (!binding?.ownerUserId) {
      if (message.chat.type === 'private' && text === this.pairCode) await this.claimOwner(binding!, userId, target)
      return
    }
    if (userId !== binding.ownerUserId) return
    const addressed = message.chat.type === 'private' || String(message.reply_to_message?.from?.id ?? '') === this.bot?.id || this.hasMention(message)
    if (!addressed) return
    const extId = String(update.update_id)
    this.targets.set(extId, target); this.lastTarget.set(userId, target)
    if (this.interactions.accept(text)) return
    if (!text) { await this.sendText(userId, '当前仅支持文本消息。', extId); return }
    const inbound: InboundTextMessage = { channel: this.kind, userId, extId, text, timestamp: Number(message.date) * 1000 || Date.now() }
    for (const listener of this.listeners) listener(inbound)
  }

  private async claimOwner(binding: PersistedChannelBinding, userId: string, target: Target): Promise<void> {
    await this.options.persistence.save({ ...binding, ownerUserId: userId })
    this.lastTarget.set(userId, target)
    this.pairCode = undefined
    this.status = { state: 'bound', connected: true, boundUserId: userId }
    await this.requireApi().sendMessage({ ...target, text: '✅ Telegram 已安全绑定，现在可以直接给 DeepSeek Harness 发任务。', signal: this.controller?.signal })
  }

  private hasMention(message: any): boolean {
    const username = this.bot?.username
    return !!username && Array.isArray(message.entities) && message.entities.some((e: any) => e.type === 'mention' && String(message.text ?? '').slice(e.offset, e.offset + e.length).toLowerCase() === `@${username.toLowerCase()}`)
  }
  private withoutMention(text: string): string { const username = this.bot?.username; return username ? text.replace(new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), '') : text }
  private requireApi(): TelegramApi { if (!this.api) throw new Error('Telegram 未连接'); return this.api }
  private requireOwner(userId: string): void { if (this.options.persistence.load()?.ownerUserId !== userId) throw new Error('Telegram owner mismatch') }
  private newPairCode(): string { return String(randomInt(100000, 1000000)) }
}
