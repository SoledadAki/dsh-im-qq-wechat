import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installApprovalAnswerer, installQuestionProvider } from '../src/approval-bridge.js'

test('question waterfall delegates Web sessions and fails closed for unroutable IM sessions', async () => {
  let listener: any
  installQuestionProvider({ on: (_name, callback) => { listener = callback; return () => {} } }, {
    adapters: new Map(), ownerBySession: new Map(), ownsSession: (id) => id === 'im', logger: { warn() {} },
  })
  const request = { agent: { id: 'web' }, questions: [{ id: 'q', question: 'choose' }] }
  const expected = { answers: [{ id: 'q', selected: [], custom: 'web answer' }] }
  assert.equal(await listener(request, async () => expected), expected)
  await assert.rejects(listener({ ...request, agent: { id: 'im' } }, async () => expected), { code: 'NO_PROVIDER' })
})

test('ordinary Harness sessions retain their own approval handler', async () => {
  let listener: any
  installApprovalAnswerer({ on: (_name, callback) => { listener = callback; return () => {} } }, {
    adapters: new Map(), ownerBySession: new Map(), ownsSession: (id) => id === 'im',
    logger: { warn() {} },
  })
  let delegated = 0
  const next = async () => { delegated++; return 'allowed-once' }
  assert.equal(await listener({ agent: { id: 'web' }, toolName: 'shell' }, next), 'allowed-once')
  assert.equal(await listener({ agent: { id: 'im' }, toolName: 'shell' }, next), 'unavailable')
  assert.equal(delegated, 1)
})

test('approval without an exact route fails closed', async () => {
  let listener: ((request: any, next: () => Promise<string>) => Promise<string>) | undefined
  installApprovalAnswerer({
    on: (_name, callback) => {
      listener = callback
      return () => undefined
    },
  }, {
    adapters: new Map(),
    ownerBySession: new Map(),
    routeForRequest: () => undefined,
    logger: { warn: () => undefined },
  })
  const outcome = await listener!({ agent: { id: 's1' }, toolName: 'shell' }, async () => 'allowed-once')
  assert.equal(outcome, 'unavailable')
})

test('user questions return the 0.1.5-rc.2 structured answer shape', async () => {
  let provider: any
  const adapter = {
    askQuestion: async () => ['允许,稍后', '自定义文本'],
  }
  installQuestionProvider({
    on: (event, listener) => {
      assert.equal(event, 'user-questions/request')
      provider = { ask: (request: any) => listener(request, async () => { throw new Error('unexpected fallback') }) }
      return () => {}
    },
  }, {
    adapters: new Map([['qq', adapter as any]]),
    ownerBySession: new Map(),
    routeForRequest: () => ({ channel: 'qq', userId: 'owner' }),
    logger: { warn: () => undefined },
  })
  const result = await provider.ask({
    agent: { id: 's1' },
    questions: [
      { id: 'q1', question: '选择', options: [{ label: '允许' }, { label: '稍后' }], multiSelect: true },
      { id: 'q2', question: '说明' },
    ],
  })
  assert.deepEqual(result, {
    answers: [
      { id: 'q1', selected: ['允许', '稍后'] },
      { id: 'q2', selected: [], custom: '自定义文本' },
    ],
  })
})
