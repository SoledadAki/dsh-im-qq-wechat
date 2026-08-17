const DEFAULT_BASE_URL = 'https://api.telegram.org/'

export function validTelegramToken(value: string): boolean {
  return /^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(value.trim())
}

export class TelegramApi {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!validTelegramToken(token)) throw new TypeError('Telegram Bot Token 格式无效')
  }

  getMe(signal?: AbortSignal): Promise<any> { return this.call('getMe', {}, signal, 15_000) }
  getWebhookInfo(signal?: AbortSignal): Promise<any> { return this.call('getWebhookInfo', {}, signal, 15_000) }
  getUpdates(offset: number | undefined, signal: AbortSignal, timeout = 25): Promise<any[]> {
    return this.call('getUpdates', { timeout, limit: 100, allowed_updates: ['message'], ...(offset === undefined ? {} : { offset }) }, signal, (timeout + 10) * 1000)
  }
  sendMessage(input: { chatId: string | number; text: string; replyToMessageId?: number; messageThreadId?: number; signal?: AbortSignal }): Promise<any> {
    return this.call('sendMessage', { chat_id: input.chatId, text: input.text, link_preview_options: { is_disabled: true }, ...(input.replyToMessageId ? { reply_parameters: { message_id: input.replyToMessageId, allow_sending_without_reply: true } } : {}), ...(input.messageThreadId ? { message_thread_id: input.messageThreadId } : {}) }, input.signal, 15_000)
  }
  editMessageText(chatId: string | number, messageId: number, text: string, signal?: AbortSignal): Promise<any> {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } }, signal, 15_000)
  }
  sendChatAction(chatId: string | number, messageThreadId?: number, signal?: AbortSignal): Promise<any> {
    return this.call('sendChatAction', { chat_id: chatId, action: 'typing', ...(messageThreadId ? { message_thread_id: messageThreadId } : {}) }, signal, 15_000)
  }

  private async call(method: string, payload: object, signal: AbortSignal | undefined, timeoutMs: number): Promise<any> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(`${DEFAULT_BASE_URL}bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: combined, redirect: 'error' })
    } catch (error) {
      if ((error as Error).name === 'AbortError' || (error as Error).name === 'TimeoutError') throw error
      throw new Error(`Telegram ${method} 网络请求失败`)
    }
    const body = await response.json().catch(() => undefined) as any
    if (!response.ok || body?.ok !== true) throw new Error(body?.description ?? `Telegram ${method} 失败`)
    return body.result
  }
}
