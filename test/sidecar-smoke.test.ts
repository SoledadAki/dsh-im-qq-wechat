import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { SidecarClient } from '../src/sidecar-client.js'

for (const kind of ['qq', 'weixin'] as const) {
  test(`${kind} production sidecar completes authenticated lifecycle`, async () => {
    const errors: string[] = []
    const client = new SidecarClient({
      script: fileURLToPath(new URL(`../sidecar/${kind}/main.mjs`, import.meta.url)),
      profileId: 'smoke',
      logger: {
        warn: (message) => errors.push(message),
        error: (message) => errors.push(message),
      },
    })
    await client.start()
    const health = await client.request('health.ping', { nonce: kind }, ['health.pong'])
    assert.equal(health.payload.nonce, kind)
    await client.stop()
    assert.deepEqual(errors, [])
  })
}
