import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentManager, type AgentHandleLike, type AgentLike } from '../src/agent-bridge.js'

test('setup initializes the explicit Agent argument supplied by the new Host', async () => {
  const appended: unknown[] = []
  const agent = { id: 'created', session: { append: (...args: unknown[]) => appended.push(args) } } as unknown as AgentLike
  const manager = new AgentManager({
    create: async (options) => {
      // No ctx.agent property: the new setup contract supplies agent separately.
      await options.setup?.({} as any, agent)
      return { agent, async dispose() {} }
    }, resume: async () => { throw new Error('not used') }, get: () => undefined,
  }, { sharedSession: false, approvalPolicy: 'ask', getBinding: () => undefined, persistBinding: async () => {}, logger: { info() {}, warn() {} } })
  await manager.createFresh('qq', 'owner')
  assert.deepEqual(appended, [['approval/policy', { policy: 'ask' }]])
})

test('AgentManager disposes a replaced session only through its owned handle', async () => {
  let disposed = 0
  let bound = ''
  const agent = { id: 'reset-session-1', session: { id: 'reset-session-1', snapshotEvents: () => [] }, status: 'idle' } as unknown as AgentLike
  const handle: AgentHandleLike = { agent, async dispose() { disposed++ } }
  const manager = new AgentManager(
    { create: async () => handle, resume: async () => handle, get: () => undefined },
    { sharedSession: false, approvalPolicy: 'ask', getBinding: () => undefined, persistBinding: async (_key, id) => { bound = id }, logger: { info() {}, warn() {} } },
  )
  await manager.createFresh('telegram', 'owner', undefined, 'C:/work')
  assert.match(bound, /^qq-weixin-telegram-owner-/)
  await manager.disposeOwned('reset-session-1')
  await manager.disposeOwned('reset-session-1')
  assert.equal(disposed, 1)
})

test('AgentManager rebuilds with a model route and preserves the completed event seed', async () => {
  const events = [
    { seq: 0, type: 'user/message', data: { message: { role: 'user', content: [] } } },
    { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } },
  ] as any[]
  const source = {
    id: 'old-session',
    session: { id: 'old-session', snapshotEvents: () => events },
    status: 'idle',
  } as unknown as AgentLike
  let createdOptions: any
  let bound = ''
  const manager = new AgentManager(
    {
      create: async (options) => {
        createdOptions = options
        const agent = { id: options.sessionId, session: { id: options.sessionId, snapshotEvents: () => options.seed ?? [] }, status: 'idle' } as unknown as AgentLike
        return { agent, async dispose() {} }
      },
      resume: async () => { throw new Error('not used') },
      get: () => undefined,
    },
    {
      sharedSession: false,
      approvalPolicy: 'ask',
      getBinding: () => undefined,
      persistBinding: async (_key, id) => { bound = id },
      logger: { info() {}, warn() {} },
    },
  )

  const result = await manager.forkWithModel(
    'qq', 'owner', source, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, undefined, 'C:/work',
  )

  assert.equal(bound, result.sessionId)
  assert.deepEqual(createdOptions.seed, events)
  assert.notEqual(createdOptions.seed, events)
  assert.equal(createdOptions.meta.parentSession, 'old-session')
  assert.equal(createdOptions.inheritedEventCount, events.length)
  assert.deepEqual(createdOptions.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})
