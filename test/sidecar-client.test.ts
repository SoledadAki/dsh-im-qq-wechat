import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { SidecarClient } from '../src/sidecar-client.js'

function makeClient() {
  return new SidecarClient({
    script: fileURLToPath(new URL('./fixtures/echo-sidecar.mjs', import.meta.url)),
    profileId: 'test', requestTimeoutMs: 200, handshakeTimeoutMs: 2000,
    logger: { warn() {}, error() {} },
  })
}

for (const type of ['invalid', 'oversized', 'bad-token']) {
  test(`rejects ${type} frames and restarts without stale exit handlers`, async () => {
    const client = makeClient()
    try {
      await assert.rejects(client.request(type, {}, ['echo.result']), /protocol failure/)
      assert.equal((await client.request('echo', { value: 42 }, ['echo.result'])).payload.value, 42)
    } finally { await client.stop() }
  })
}

test('request timeout leaves the next request usable', async () => {
  const client = makeClient()
  try {
    await assert.rejects(client.request('silent', {}, ['echo.result']), /timed out/)
    assert.equal((await client.request('echo', { value: 1 }, ['echo.result'])).payload.value, 1)
  } finally { await client.stop() }
})

test('concurrent shutdown and immediate restart preserve the new child', async () => {
  const client = makeClient()
  try {
    await client.start()
    await Promise.all([client.stop(), client.stop(), client.start()])
    assert.equal((await client.request('echo', { value: 2 }, ['echo.result'])).payload.value, 2)
  } finally { await client.stop() }
})

test('a failing event listener does not break other subscribers', async () => {
  const client = makeClient()
  try {
    client.onEvent(() => { throw new Error('consumer failed') })
    const received = new Promise<void>((resolve) => client.onEvent(() => resolve()))
    await client.send('notice')
    await received
    await client.request('echo', {}, ['echo.result'])
  } finally { await client.stop() }
})

test('SidecarClient authenticates, correlates requests, and shuts down', async () => {
  const messages: string[] = []
  const client = new SidecarClient({
    script: fileURLToPath(new URL('./fixtures/echo-sidecar.mjs', import.meta.url)),
    profileId: 'test',
    logger: {
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
  })
  await client.start()
  const result = await client.request('echo', { value: 42 }, ['echo.result'])
  assert.equal(result.payload.value, 42)
  await client.stop()
  assert.deepEqual(messages, [])
})
