import assert from 'node:assert/strict'
import test from 'node:test'
import { SidecarChannelAdapter } from '../src/sidecar-channel.js'

for (const kind of ['qq', 'wechat'] as const) {
  test(`${kind} cancels questions even if message delivery stalls`, async () => {
    const adapter = new SidecarChannelAdapter({ kind, profileId: 'test', stateDir: '.', secretRef: 'test',
      credentials: { async resolve() { return undefined }, async set() {}, async unset() {} },
      persistence: { load: () => ({ accountId: 'bot', ownerUserId: 'owner' }), async save() {}, async clear() {} },
      logger: { info() {}, warn() {}, error() {} },
    })
    let sends = 0
    ;(adapter as any).client.request = () => { sends++; return new Promise(() => {}) }
    assert.equal(await adapter.askApproval('owner', { toolName: 'write' }, AbortSignal.abort()), 'cancelled')
    assert.equal(sends, 0)
    const controller = new AbortController()
    const answer = adapter.askQuestion('owner', [{ id: 'q', question: 'Review', detail: 'Change a file' }], controller.signal)
    const rejected = assert.rejects(answer, /取消/)
    controller.abort()
    await rejected
  })
  test(`${kind} sends the complete long reply without broken emoji`, async () => {
    const adapter = new SidecarChannelAdapter({ kind, profileId: 'test', stateDir: '.', secretRef: 'test',
      credentials: { async resolve() { return undefined }, async set() {}, async unset() {} },
      persistence: { load: () => ({ accountId: 'bot', ownerUserId: 'owner' }), async save() {}, async clear() {} },
      logger: { info() {}, warn() {}, error() {} },
    })
    const sent: string[] = []
    // Replace only the wire transport so this exercises the real adapter.
    ;(adapter as any).client.request = async (_type: string, payload: any) => {
      sent.push(payload.text)
      assert.equal(payload.reply_to_id, 'incoming')
      return { type: 'message.sent' }
    }
    const text = '中'.repeat(3999) + '😀' + '文'.repeat(6000)
    await adapter.sendText('owner', text, 'incoming')
    assert.equal(sent.join(''), text)
    assert.ok(sent.every((part) => part.length <= (kind === 'qq' ? 5000 : 4000) && part.isWellFormed()))
    await assert.rejects(adapter.sendText('stranger', 'no'), /owner/)
  })
}

test('QQ native stream failure falls back to a normal final reply and disables streaming', async () => {
  const warnings: string[] = []
  const adapter = new SidecarChannelAdapter({ kind: 'qq', profileId: 'test', stateDir: '.', secretRef: 'test',
    credentials: { async resolve() { return undefined }, async set() {}, async unset() {} },
    persistence: { load: () => ({ accountId: 'bot', ownerUserId: 'owner' }), async save() {}, async clear() {} },
    logger: { info() {}, warn(message) { warnings.push(message) }, error() {} },
  })
  const sent: Array<{ text: string; replyToId: string }> = []
  ;(adapter as any).client.request = async (type: string, payload: any) => {
    if (type === 'stream.update') return { type: 'stream.failed' }
    if (type === 'message.send') {
      sent.push({ text: payload.text, replyToId: payload.reply_to_id })
      return { type: 'message.sent' }
    }
    return { type: 'stream.ok' }
  }
  const stream = await adapter.openReplyStream('owner', 'incoming')
  assert.ok(stream)
  await assert.doesNotReject(stream.update('partial answer'))
  await stream.finish('complete answer')
  assert.deepEqual(sent, [{ text: 'complete answer', replyToId: 'incoming' }])
  assert.equal(await adapter.openReplyStream('owner', 'next'), undefined)
  assert.equal(warnings.length, 1)
})

test('QQ failed stream finish also sends the final answer as a normal reply', async () => {
  const adapter = new SidecarChannelAdapter({ kind: 'qq', profileId: 'test', stateDir: '.', secretRef: 'test',
    credentials: { async resolve() { return undefined }, async set() {}, async unset() {} },
    persistence: { load: () => ({ accountId: 'bot', ownerUserId: 'owner' }), async save() {}, async clear() {} },
    logger: { info() {}, warn() {}, error() {} },
  })
  const sent: string[] = []
  ;(adapter as any).client.request = async (type: string, payload: any) => {
    if (type === 'stream.finish') return { type: 'stream.failed' }
    if (type === 'message.send') { sent.push(payload.text); return { type: 'message.sent' } }
    return { type: 'stream.ok' }
  }
  const stream = await adapter.openReplyStream('owner', 'incoming')
  assert.ok(stream)
  await stream.finish('complete answer')
  assert.deepEqual(sent, ['complete answer'])
})
