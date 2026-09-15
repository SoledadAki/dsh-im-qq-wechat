import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChannelPersistence, CredentialAccess, PersistedChannelBinding } from '../src/sidecar-channel.js'
import { TelegramChannelAdapter } from '../src/telegram-channel.js'

const binding: PersistedChannelBinding = { accountId: '42', ownerUserId: '7' }

function makeAdapter(gate: () => Promise<void>) {
  let getMeCalls = 0
  const credentials: CredentialAccess = {
    resolve: async () => ({ value: '123456:abcdefghijklmnopqrstuvwxyz_1234' }),
    set: async () => undefined,
    unset: async () => undefined,
  }
  const persistence: ChannelPersistence = {
    load: () => binding,
    save: async () => undefined,
    clear: async () => undefined,
  }
  const adapter = new TelegramChannelAdapter({
    tokenRef: 'telegram-token',
    credentials,
    persistence,
    logger: { info() {}, warn() {}, error() {} },
    createApi: () => ({
      getMe: async () => { getMeCalls += 1; await gate(); return { id: 42, is_bot: true } },
      getWebhookInfo: async () => ({}),
      getUpdates: async () => [],
      sendMessage: async () => ({}),
      editMessageText: async () => ({}),
      sendChatAction: async () => ({}),
    }) as never,
  })
  return { adapter, getMeCalls: () => getMeCalls }
}

/** Let pending microtasks and one macrotask turn settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('断开 during the handshake still permits a real reconnect', async () => {
  // Regression guard: start() memoizes its in-flight attempt, so if stop() does
  // not drop that memo a 断开 → 连接 pair reuses the abandoned attempt.  The old
  // attempt then aborts on its own generation check and start() resolves with a
  // dead channel (getMe called once, connected false), requiring a third click.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { adapter, getMeCalls } = makeAdapter(() => gate)

  const first = adapter.start()
  await settle()
  assert.equal(getMeCalls(), 1, 'the first attempt must have reached the handshake')

  await adapter.stop()
  release()
  await first.catch(() => undefined)

  await adapter.start()
  assert.equal(getMeCalls(), 2, '连接 must start a fresh attempt instead of reusing the abandoned one')
  assert.equal(adapter.getStatus().connected, true)
  assert.equal(adapter.getStatus().state, 'bound')
  await adapter.dispose()
})

test('a start superseded by stop() does not clobber the newer attempt', async () => {
  // The abandoned attempt must leave the newer attempt's controller/client alone:
  // its cleanup is identity-checked, and its generation check fails first.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { adapter } = makeAdapter(() => gate)

  const first = adapter.start()
  await settle()
  await adapter.stop()
  const second = adapter.start()
  release()
  await first.catch(() => undefined)
  await second

  assert.equal(adapter.getStatus().connected, true)
  await adapter.dispose()
  assert.equal(adapter.getStatus().connected, false)
})
