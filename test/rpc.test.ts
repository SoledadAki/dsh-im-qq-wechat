import assert from 'node:assert/strict'
import test from 'node:test'
import { installImRpc } from '../src/rpc.js'

test('authenticated Fetch routes match browser RPC envelopes and release every registration', async () => {
  const routes: any[] = []
  let disposed = 0
  let calls = 0
  const stop = installImRpc({ fetch: { register(route: any) { routes.push(route); return async () => { disposed++ } } } } as any,
    async () => { calls++; return { ok: true, value: {} } })
  const route = routes.find((route) => route.path === '/api/qqbot/status')
  const request = (body: unknown, type = 'application/json') => new Request('http://localhost/api/qqbot/status', { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) })
  assert.equal((await route.fetch(request({}))).status, 400)
  assert.equal((await route.fetch(request({}, 'text/plain'))).status, 415)
  assert.equal((await route.fetch(request({ type: 'client-request', rpcId: '1', method: 'status', payload: {} }))).status, 400)
  const response = await route.fetch(request({ type: 'client-request', rpcId: '1', method: 'qqbot/status', payload: {} }))
  assert.equal((await response.json()).result.ok, true)
  assert.equal(calls, 1)
  await stop()
  assert.equal(disposed, routes.length)
})
