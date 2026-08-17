import type { ChannelReplyStream } from './channel.js'

export function splitMessageText(value: string, limit: number): string[] {
  const text = value.trim()
  if (!text) return []
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit * 0.55)) cut = remaining.lastIndexOf(' ', limit)
    if (cut < Math.floor(limit * 0.55)) cut = limit
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
      if (first !== lastSent) await options.edit(messageId, first)
      for (const chunk of chunks.slice(1)) await options.sendRemainder(chunk)
    },
    cancel() {
      closed = true
      pending = undefined
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
