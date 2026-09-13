import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const directory = await mkdtemp(join(tmpdir(), 'dsh-im-host-'))
const home = join(directory, 'home')
const cli = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))), 'lib/bin.js')
const archive = join(directory, `${manifest.name}-${manifest.version}.tgz`)
await copyFile(resolve('dist', `${manifest.name}-${manifest.version}.tgz`), archive)
const env = { ...process.env, DSH_HOME: home, CI: 'true', NO_COLOR: '1' }
const installed = spawnSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', archive, '--ignore-scripts'], { env, encoding: 'utf8', windowsHide: true, timeout: 180_000 })
assert.equal(installed.status, 0, installed.stderr)
const installedRoot = join(home, 'profiles', 'web', 'node_modules', manifest.name)
const probe = join(directory, 'probe.mjs')
await writeFile(probe, `
import assert from 'node:assert/strict'
import { AgentManager } from ${JSON.stringify(pathToFileURL(join(installedRoot, 'lib/agent-bridge.js')).href)}
import { installQuestionProvider } from ${JSON.stringify(pathToFileURL(join(installedRoot, 'lib/approval-bridge.js')).href)}
export const inject = ['agents', 'agentPresets', 'permissionPresets', 'userQuestions', 'timer']
export function apply(ctx) {
  ctx.timeout(() => { void runProbe(ctx).catch(error => console.error('agent_contract_failed:', error)) }, 50)
}
async function runProbe(ctx) {
  let binding
  const preset = await ctx.agentPresets.resolve()
  const manager = new AgentManager(ctx.agents, { sharedSession: false, approvalPolicy: 'ask', presets: ctx.agentPresets,
    getBinding: () => binding, persistBinding: async (_key, id) => { binding = id },
    getModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), logger: { info() {}, warn() {} } })
  const { agent } = await manager.createFresh('qq', 'fixture-owner', preset.id, ${JSON.stringify(directory)})
  assert.equal(typeof ctx.permissionPresets.current(agent.session), 'string')
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'approval/policy'))
  const stopQuestions = installQuestionProvider(ctx, {
    ownsSession: id => id === agent.id, ownerBySession: new Map([[agent.id, { channel: 'qq', userId: 'fixture-owner' }]]),
    adapters: new Map([['qq', { askQuestion: async () => ['fixture answer'] }]]), logger: { warn() {} },
  })
  const answer = await ctx.userQuestions.ask({ agent, signal: AbortSignal.timeout(5000), questions: [{ id: 'probe', question: 'fixture question' }] })
  assert.equal(answer.answers[0].custom, 'fixture answer')
  stopQuestions()
  const fork = await manager.forkWithModel('qq', 'fixture-owner', agent, { provider: 'fixture', model: 'fixture-2' }, preset.id, ${JSON.stringify(directory)})
  assert.notEqual(fork.agent.id, agent.id)
  await manager.disposeOwned(agent.id)
  await manager.disposeOwned(fork.agent.id)
  console.log('agent_contract_ok: create, preset, permissions, question waterfall, history, fork, dispose')
}
`)
const overlay = join(directory, 'probe.yml')
await writeFile(overlay, `- insert:\n    - id: plugin-contract-probe\n      name: ${JSON.stringify(pathToFileURL(probe).href)}\n`)
const child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
let failure
child.on('error', (error) => { failure = error })
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })
const deadline = Date.now() + 60_000
try {
  let address
  while (!(address = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/.exec(output)?.[1])) {
    if (failure) throw failure
    if (child.exitCode !== null) throw new Error(`Host exited: ${output}`)
    if (Date.now() > deadline) throw new Error(`Host startup timed out: ${output}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // Exchange the private launch URL for a browser session, never print its token.
  const launch = new URL(address)
  const auth = await fetch(launch, { redirect: 'manual' })
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'Host did not issue a browser session')
  const headers = { cookie, origin: launch.origin, 'content-type': 'application/json' }
  const index = await fetch(launch.origin, { headers })
  assert.equal(index.status, 200)
  const html = await index.text()
  assert.ok(html.includes('dsh-im-qq-wechat'), 'Plugin missing from browser boot roster')
  const request = (method, payload = {}, requestHeaders = headers) => fetch(`${launch.origin}/api/qqbot/${method}`, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-1', method, payload }) })
  const unauthenticated = await request('status', {}, { 'content-type': 'application/json' })
  assert.equal(unauthenticated.status, 401)
  const response = await request('status')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.result.ok, true, JSON.stringify(body))
  assert.deepEqual(Object.keys(body.result.value.channels).sort(), ['feishu', 'qq', 'telegram', 'wechat', 'wecom'])
  for (const { status } of Object.values(body.result.value.channels)) assert.equal(status.state, 'idle')
  const invalid = await (await request('connect', { channel: 'unknown' })).json()
  assert.equal(invalid.result.ok, false)
  assert.ok(invalid.result.error.details, 'RPC failures must satisfy the current envelope')
  while (!output.includes('agent_contract_ok')) {
    if (output.includes('agent_contract_failed:') || Date.now() > deadline) throw new Error('Agent probe failed: ' + output.replace(/([?&]token=)[^\s&)]+/g, '$1[redacted]'))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  console.log('host_verified: Harness 0.1.5-rc.2 boots installed archive; browser roster, authenticated status, five idle channels, unauthorized requests rejected')
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
  // Retain logs privately for failed-run diagnosis; redact the launch credential.
  await writeFile(join(directory, 'host.log'), output.replace(/([?&]token=)[^\s&)]+/g, '$1[redacted]'))
}
