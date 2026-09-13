import { clientRequestSchema, type HostConnectionHandle, type ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

/** Exact routes share Harness browser authentication without owning /api. */
export function installImRpc(
  connection: HostConnectionHandle,
  dispatch: (endpoint: string, payload: unknown) => Promise<ConnectionRpcResult<unknown>>,
): () => Promise<void> {
  const endpoints = ['status', 'configure', 'begin', 'verify', 'cancel', 'unbind', 'disconnect', 'connect']
  const disposers = endpoints.map((endpoint) => connection.fetch.register({
    path: `/api/qqbot/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return new Response('JSON required', { status: 415 })
      const message = clientRequestSchema.safeParse(await request.json().catch(() => undefined))
      if (!message.success || message.data.method !== endpoint) return new Response('Invalid RPC envelope', { status: 400 })
      return Response.json({ type: 'server-response', rpcId: message.data.rpcId, result: await dispatch(endpoint, message.data.payload) })
    },
  }))
  return async () => { await Promise.all(disposers.map((dispose) => dispose())) }
}
