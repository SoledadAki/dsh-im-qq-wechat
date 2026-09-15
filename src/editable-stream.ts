import type { ChannelReplyStream } from './channel.js'

/**
 * Truncate to `limit` UTF-16 units without splitting a surrogate pair.
 * `String#slice` cuts between the halves of an astral character (emoji, rare
 * CJK), producing a lone surrogate that is not well-formed UTF-16 and is
 * rejected or mangled by platform APIs.
 */
export function truncateMessageText(value: string, limit: number): string {
  if (value.length <= limit) return value
  let cut = Math.max(0, limit)
  if (cut > 0 && cut < value.length && /[\uD800-\uDBFF]/.test(value[cut - 1]!) && /[\uDC00-\uDFFF]/.test(value[cut]!)) cut--
  return value.slice(0, cut)
}

/**
 * Split by UTF-8 byte budget.  WeCom caps a streamed reply at 20480 *bytes*
 * while `String#length` counts UTF-16 units and a CJK character costs three
 * bytes, so a code-unit limit overshoots the platform cap by ~3x.
 */
export function splitMessageTextByBytes(value: string, byteLimit: number): string[] {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 4) throw new RangeError('byte limit must be an integer of at least 4')
  const text = value.trim()
  if (!text) return []
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (current !== '' && currentBytes + size > byteLimit) {
      chunks.push(current.trim())
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += size
  }
  if (current.trim() !== '') chunks.push(current.trim())
  return chunks
}

export function splitMessageText(value: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError('message limit must be an integer of at least 2')
  const text = value.trim()
  if (!text) return []
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit * 0.55)) cut = remaining.lastIndexOf(' ', limit)
    if (cut < Math.floor(limit * 0.55)) cut = limit
    // Keep UTF-16 surrogate pairs intact at the platform length boundary.
    if (cut > 0 && /[\uD800-\uDBFF]/.test(remaining[cut - 1]!) && /[\uDC00-\uDFFF]/.test(remaining[cut]!)) cut--
    chunks.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/** Adapted from xmanrui/dsh-im (MIT): throttled editable-message streaming. */
export async function createEditableMessageStream(options: {
  initialText?: string
  limit: number
  updateIntervalMs?: number
  create(text: string): Promise<string | number>
  edit(messageId: string | number, text: string): Promise<unknown>
  sendRemainder(text: string): Promise<unknown>
  logger?: { warn(message: string, ...rest: unknown[]): void }
}): Promise<ChannelReplyStream> {
  const initialText = options.initialText ?? '正在思考…'
  const interval = options.updateIntervalMs ?? 800
  const messageId = await options.create(initialText)
  let pending: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let closed = false
  let lastSent = initialText

  const schedule = (): void => {
    if (closed || timer !== undefined || inFlight !== undefined || !pending) return
    timer = setTimeout(() => {
      timer = undefined
      const next = splitMessageText(pending ?? '', options.limit)[0] ?? initialText
      pending = undefined
      inFlight = Promise.resolve(next === lastSent ? undefined : options.edit(messageId, next))
        .then(() => { lastSent = next })
        .catch((error) => options.logger?.warn('stream update failed', error))
        .finally(() => { inFlight = undefined; schedule() })
    }, interval)
    timer.unref?.()
  }

  return {
    update(text) {
      if (closed || !text.trim()) return
      pending = text
      schedule()
    },
    async finish(text) {
      if (closed) return
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = undefined
      await inFlight?.catch(() => undefined)
      const chunks = splitMessageText(text, options.limit)
      const first = chunks[0] ?? '处理完成。'
      if (first !== lastSent) {
        try {
          await options.edit(messageId, first)
        } catch (error) {
          // A rejected final edit — 429 flood during streaming, the user deleted
          // the message, "message is not modified" — used to abort before the
          // remainder loop, so a multi-chunk answer silently stopped at the
          // stale streaming preview.  Deliver it as a fresh message instead.
          options.logger?.warn('stream final edit failed; sending the answer as a new message', error)
          await Promise.resolve(options.sendRemainder(first)).catch(() => undefined)
        }
      }
      for (const chunk of chunks.slice(1)) {
        // Best effort per chunk: one rejection must not drop the rest of the answer.
        await Promise.resolve(options.sendRemainder(chunk)).catch((error: unknown) => options.logger?.warn('stream remainder failed', error))
      }
    },
    cancel() {
      closed = true
      pending = undefined
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
