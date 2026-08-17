import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installApprovalAnswerer, installQuestionProvider } from '../src/approval-bridge.js'

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

test('user questions return the rc.6 structured answer shape', async () => {
  let provider: any
  const adapter = {
    askQuestion: async () => ['允许,稍后', '自定义文本'],
  }
  installQuestionProvider({
    userQuestions: {
      registerProvider: (value) => {
        provider = value
        return () => undefined
      },
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
