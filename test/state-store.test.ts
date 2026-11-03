import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createStateScope, migrateLegacyState } from '../src/state-store.js'

function fakeHost(initial: Record<string, Record<string, string>> = {}) {
  const store: Record<string, Record<string, string>> = { ...initial }
  const calls: Array<[string, string, object]> = []
  const config = new Proxy({}, { get: (_target, key: string) => ({ get: () => store[key] }) })
  const settings = {
    async update(ns: string, patch: Record<string, Record<string, string>>) {
      calls.push(['update', ns, patch])
      for (const [key, value] of Object.entries(patch)) store[key] = { ...store[key], ...value }
    },
    async replace(ns: string, section: Record<string, Record<string, string>>) {
      calls.push(['replace', ns, section])
      for (const key of Object.keys(store)) delete store[key]
      Object.assign(store, section)
    },
    configure: () => () => {},
  }
  return { store, calls, scope: createStateScope(settings, 'qq-weixin', config) }
}

test('state scope maps the 0.1 channels key onto the channelState config field', async () => {
  const { store, calls, scope } = fakeHost({ channelState: { qq: 'a' }, bindings: { k: 's' } })
  assert.deepEqual(scope.get(), { channels: { qq: 'a' }, bindings: { k: 's' } })
  await scope.update({ channels: { feishu: 'b' } })
  assert.deepEqual(calls[0], ['update', 'qq-weixin', { channelState: { feishu: 'b' } }])
  assert.deepEqual(store.channelState, { qq: 'a', feishu: 'b' })
  await scope.replace({ bindings: {}, channels: { qq: 'a' }, sessions: {}, histories: {}, workspaces: {}, efforts: {}, models: {} })
  assert.deepEqual(scope.get().channels, { qq: 'a' })
  assert.equal(calls[1]![0], 'replace')
})

test('legacy settings.yaml section is imported once, from the renamed file too', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qq-weixin-state-'))
  await writeFile(join(home, 'settings.yaml.imported'), [
    'qq-weixin:',
    '  bindings: {feishu:owner: s1}',
    "  channels: {feishu: '{\"ownerUserId\":\"owner\"}'}",
    '  bogus: [1, 2]',
    'other: {x: 1}',
  ].join('\n'))
  const { store, calls, scope } = fakeHost()
  const logs: string[] = []
  const logger = { info: (msg: string) => logs.push(msg), warn: (msg: string) => logs.push(msg) }
  await migrateLegacyState(scope, home, logger)
  assert.deepEqual(store, { bindings: { 'feishu:owner': 's1' }, channelState: { feishu: '{"ownerUserId":"owner"}' } })
  assert.match(logs[0]!, /settings\.yaml\.imported/)
  await migrateLegacyState(scope, home, logger)
  assert.equal(calls.length, 1, 'existing state must never be overwritten')
})

test('migration is a no-op without a profile home or legacy file', async () => {
  const { calls, scope } = fakeHost()
  const logger = { info() {}, warn() {} }
  await migrateLegacyState(scope, undefined, logger)
  await migrateLegacyState(scope, await mkdtemp(join(tmpdir(), 'qq-weixin-empty-')), logger)
  assert.equal(calls.length, 0)
})
