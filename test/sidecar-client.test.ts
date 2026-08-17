import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { SidecarClient } from '../src/sidecar-client.js'

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
