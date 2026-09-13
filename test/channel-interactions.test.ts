import assert from 'node:assert/strict'
import test from 'node:test'
import { ChannelInteractions } from '../src/channel-interactions.js'

const questions = [{ id: 'q1', question: 'Choose a workspace' }]

test('pre-cancelled prompts are never sent', async () => {
  const sent: string[] = []
  const interactions = new ChannelInteractions(async (text) => { sent.push(text) })
  const signal = AbortSignal.abort()
  assert.equal(await interactions.askApproval({ toolName: 'write' }, signal), 'cancelled')
  await assert.rejects(interactions.askQuestion(questions, signal), /取消/)
  assert.deepEqual(sent, [])
})

test('cancellation settles even when transport never resolves', async () => {
  const interactions = new ChannelInteractions(() => new Promise(() => {}))
  const controller = new AbortController()
  const approval = interactions.askApproval({ toolName: 'write' }, controller.signal)
  const answer = interactions.askQuestion(questions, controller.signal)
  const rejected = assert.rejects(answer, /取消/)
  controller.abort()
  assert.equal(await approval, 'cancelled')
  await rejected
})

test('timeout settles questions while transport is still pending', async () => {
  const interactions = new ChannelInteractions(() => new Promise(() => {}), 10)
  await assert.rejects(interactions.askQuestion(questions), /超时/)
  assert.equal(await interactions.askApproval({ toolName: 'write' }), 'unavailable')
})

test('delivery failure fails closed and answers require the matching id', async () => {
  const broken = new ChannelInteractions(async () => { throw new Error('offline') })
  assert.equal(await broken.askApproval({ toolName: 'write' }), 'unavailable')
  await assert.rejects(broken.askQuestion(questions), /offline/)
  let text = ''
  const interactions = new ChannelInteractions(async (value) => { text = value })
  const answer = interactions.askQuestion(questions)
  const id = /#([a-f0-9]{8})/.exec(text)![1]
  assert.equal(interactions.accept(`/answer ${id} workspace`), true)
  assert.deepEqual(await answer, ['workspace'])
  interactions.cancel()
})
