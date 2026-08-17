import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const filename = new URL('../lib/client.js', import.meta.url)
const source = await readFile(filename, 'utf8')

if (!/^\s*["']use strict["'];\s*\(\(\)\s*=>\s*\{/u.test(source)) {
  throw new Error('client bundle must be a strict-mode IIFE')
}
if (/(^|[;\n}])\s*export\s/mu.test(source) || /(^|[;\n}])\s*import\s/mu.test(source) || /\bimport\s*\(|\bimport\.meta\b/u.test(source)) {
  throw new Error('client bundle contains forbidden ESM syntax')
}
if (!source.includes('window.__ModuleLoader__.load({')) {
  throw new Error('client bundle does not synchronously call window.__ModuleLoader__.load')
}

const registrations = []
const context = vm.createContext({
  window: {
    __ModuleLoader__: {
      load(handoff) { registrations.push(handoff) },
    },
  },
})
new vm.Script(source, { filename: 'lib/client.js' }).runInContext(context)

if (registrations.length !== 1) {
  throw new Error(`client bundle registered ${registrations.length} modules; expected exactly one`)
}
const [handoff] = registrations
if (handoff?.id !== 'dsh-im-qq-wechat') {
  throw new Error(`client bundle registered ${JSON.stringify(handoff?.id)}; expected "dsh-im-qq-wechat"`)
}
if (typeof handoff.factory !== 'function') {
  throw new Error('client bundle registration is missing its factory')
}

console.log('client_bundle_ok iife=true esm=false id=dsh-im-qq-wechat')
