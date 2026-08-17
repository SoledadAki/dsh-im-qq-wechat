import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditableMessageStream, splitMessageText } from '../src/editable-stream.js'
import { TelegramApi, validTelegramToken } from '../src/telegram-api.js'
import { InboundTracker } from '../src/correlation.js'

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
