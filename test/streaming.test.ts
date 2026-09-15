import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditableMessageStream, splitMessageText, splitMessageTextByBytes, truncateMessageText } from '../src/editable-stream.js'
import { TelegramApi, validTelegramToken } from '../src/telegram-api.js'
import { InboundTracker } from '../src/correlation.js'

test('new Host live streams correlate attempts and ignore stale or duplicate chunks', () => {
  const tracker = new InboundTracker()
  tracker.register({ extId: 'a', sessionId: 's', channel: 'qq', userId: 'u', msgId: 'm' })
  tracker.onInboxClaimed('m', 1)
  const start = { type: 'start', attemptId: 'attempt', revision: 1, turn: 1, step: 1 } as const
  tracker.onAssistantStream('s', start as any)
  const chunk = { type: 'chunk', attemptId: 'attempt', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } } as const
  assert.equal(tracker.onAssistantStream('s', chunk as any)[0]?.streamText, '你好')
  assert.deepEqual(tracker.onAssistantStream('s', chunk as any), [])
  tracker.onAssistantStream('s', { ...start, attemptId: 'retry', revision: 2 } as any)
  assert.deepEqual(tracker.onAssistantStream('s', { ...chunk, index: 1 } as any), [])
  assert.equal(tracker.onAssistantStream('s', { ...chunk, attemptId: 'retry', revision: 2 } as any)[0]?.streamText, '你好')
  tracker.dropSession('s')
  assert.deepEqual(tracker.onAssistantStream('s', { ...chunk, index: 2 } as any), [])
})

test('message splitting rejects invalid limits and preserves surrogate pairs', () => {
  for (const limit of [0, -1, 1, 1.5, NaN, Infinity]) assert.throws(() => splitMessageText('hello', limit), RangeError)
  const text = 'abcd😀你好😀abc'
  const chunks = splitMessageText(text, 5)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 5 && chunk.isWellFormed()))
})

test('Telegram token validation and Bot API request avoid redirects', async () => {
  assert.equal(validTelegramToken('123456:abcdefghijklmnopqrstuvwxyz_1234'), true)
  assert.equal(validTelegramToken('bad-token'), false)
  let request: RequestInit | undefined
  const api = new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz_1234', async (_url, init) => {
    request = init
    return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true } }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  assert.equal((await api.getMe()).id, 1)
  assert.equal(request?.redirect, 'error')
})

test('editable stream throttles updates and splits the final reply', async () => {
  const edits: string[] = []
  const rest: string[] = []
  const stream = await createEditableMessageStream({ limit: 5, updateIntervalMs: 1, create: async () => 7, edit: async (_id, text) => { edits.push(text) }, sendRemainder: async (text) => { rest.push(text) } })
  stream.update('abc')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await stream.finish('12345 67890')
  assert.deepEqual(splitMessageText('12345 67890', 5), ['12345', '67890'])
  assert.deepEqual(edits, ['abc', '12345'])
  assert.deepEqual(rest, ['67890'])
})

test('claimed Harness text deltas route only to their exact active turn', () => {
  const tracker = new InboundTracker()
  tracker.register({ extId: 'a', sessionId: 's', channel: 'telegram', userId: 'u', msgId: 'm' })
  tracker.onInboxClaimed('m', 3)
  assert.equal(tracker.appendTextDelta('s', 2, 'wrong').length, 0)
  assert.equal(tracker.appendTextDelta('s', 3, '你')[0]?.streamText, '你')
  assert.equal(tracker.appendTextDelta('s', 3, '好')[0]?.streamText, '你好')
})

test('byte-budget splitting keeps CJK replies inside a platform byte cap', () => {
  for (const limit of [0, 3, 1.5, NaN, Infinity]) assert.throws(() => splitMessageTextByBytes('hello', limit), RangeError)
  // WeCom documents 20480 *bytes*; counting UTF-16 units let a ~6.9k-character
  // Chinese answer look compliant while being ~20.7 KB of UTF-8.
  const text = '中'.repeat(10)
  const chunks = splitMessageTextByBytes(text, 9)
  assert.deepEqual(chunks, ['中中中', '中中中', '中中中', '中'])
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 9))
  assert.equal(chunks.join(''), text)
  const emoji = splitMessageTextByBytes('😀😀😀', 4)
  assert.deepEqual(emoji, ['😀', '😀', '😀'])
})

test('truncation never emits a lone surrogate', () => {
  assert.equal(truncateMessageText('abc', 5), 'abc')
  // Cutting between the halves of an astral character is not well-formed UTF-16.
  assert.equal(truncateMessageText('a😀b', 2), 'a')
  assert.equal(truncateMessageText('😀😀', 2), '😀')
  assert.ok(truncateMessageText('a😀b', 2).isWellFormed())
})

