import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Run the released archive in a fresh consumer directory, without lifecycle
// scripts, the source checkout, or development dependencies.
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const archive = resolve('dist', `${manifest.name}-${manifest.version}.tgz`)
const directory = await mkdtemp(join(tmpdir(), 'dsh-im-package-'))
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180_000, windowsHide: true,
    env: { ...process.env, CI: 'true', NODE_PATH: '' }, maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout
}
const entries = run('tar', ['-tf', archive]).trim().split(/\r?\n/)
for (const entry of entries) {
  assert.match(entry, /^package\//)
  assert.doesNotMatch(entry, /(?:^|\/)(?:test|src|scripts|node_modules|\.git|docs)(?:\/|$)|\.map$|\.log$|\.env/)
}
for (const file of ['lib/index.js', 'lib/client.js', 'sidecar/qq/main.mjs', 'sidecar/weixin/main.mjs', 'cordis.patch.yml', 'LICENSE']) {
  assert.ok(entries.includes(`package/${file}`), `missing ${file}`)
}
await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [manifest.name]: `file:${archive.replaceAll('\\', '/')}` } }))
assert.ok(process.env.npm_execpath, 'Run with pnpm run test:package')
run(process.execPath, [process.env.npm_execpath, 'install', '--prod', '--ignore-scripts', '--config.autoInstallPeers=true'])
await writeFile(join(directory, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import * as plugin from 'dsh-im-qq-wechat'
const root = new URL('./node_modules/dsh-im-qq-wechat/', import.meta.url)
assert.equal(typeof plugin.apply, 'function')
assert.ok(plugin.Config)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
for (const name of ['prepare', 'install', 'postinstall']) assert.equal(manifest.scripts[name], undefined)
const registrations = []
vm.runInNewContext(await readFile(new URL('lib/client.js', root), 'utf8'), { window: { __ModuleLoader__: { load: value => registrations.push(value) } } })
assert.equal(registrations[0]?.id, manifest.name)
const { SidecarClient } = await import(new URL('lib/sidecar-client.js', root))
for (const channel of ['qq', 'weixin']) {
  const client = new SidecarClient({ script: fileURLToPath(new URL('sidecar/' + channel + '/main.mjs', root)), profileId: 'package-smoke', logger: { warn() {}, error() {} } })
  try { await client.start() } finally { await client.stop() }
}
console.log('installed_package_ok: host import, client registration, QQ/WeChat sidecars; no install scripts')
`)
console.log(run(process.execPath, ['smoke.mjs']).trim())
console.log(`package_verified: ${entries.length} files; isolated consumer: ${directory}`)
