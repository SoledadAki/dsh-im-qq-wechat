/** Plugin runtime state on Harness 0.2: volatile Config fields of this plugin's profile entry. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'

/** The subset of `@deepseek-ai/dsh-settings` SettingsForms this plugin uses. */
export interface SettingsFormsLike {
  update(ns: string, patch: object): Promise<void>
  replace(ns: string, section: object): Promise<void>
  configure(presentation: { auto?: boolean }): () => void
}

/** State document shape used by the rest of the plugin (keys match the 0.1 settings section). */
export interface StateDoc {
  bindings: Record<string, string>
  channels: Record<string, string>
  sessions: Record<string, string>
  histories: Record<string, string>
  workspaces: Record<string, string>
  efforts: Record<string, string>
  models: Record<string, string>
}

type StateKey = keyof StateDoc
const STATE_KEYS: readonly StateKey[] = ['bindings', 'channels', 'sessions', 'histories', 'workspaces', 'efforts', 'models']

/** `channels` is already the enabled-channel list in Config, so the state field is stored as `channelState`. */
const configKey = (key: StateKey) => (key === 'channels' ? 'channelState' : key)


export interface StateScope {
  get(): Partial<StateDoc>
  /** Deep-merges the patch over the stored state. */
  update(patch: Partial<StateDoc>): Promise<void>
  /** Resets every state field, then writes the given section; the only way to revoke a key. */
  replace(section: StateDoc): Promise<void>
}

function toConfig(doc: Partial<StateDoc>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const key of STATE_KEYS) if (doc[key] !== undefined) out[configKey(key)] = doc[key]!
  return out
}

/**
 * Map the 0.1 `settings.register()` scope onto Harness 0.2 settings forms.
 * @param settings - Host settings service.
 * @param entryId - profile entry id owning this plugin instance.
 * @param config - live Config holding the volatile state references.
 */
export function createStateScope(settings: SettingsFormsLike, entryId: string, config: object): StateScope {
  return {
    get() {
      const doc: Partial<StateDoc> = {}
      for (const key of STATE_KEYS) {
        const value = (config as Record<string, { get(): unknown } | undefined>)[configKey(key)]?.get()
        if (value && typeof value === 'object') doc[key] = { ...(value as Record<string, string>) }
      }
      return doc
    },
    update: (patch) => settings.update(entryId, toConfig(patch)),
    replace: (section) => settings.replace(entryId, toConfig(section)),
  }
}

function isStringDict(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string')
}

/**
 * Import the 0.1 `qq-weixin` section of `settings.yaml` once, when this entry holds no state yet.
 *
 * Harness 0.2 imports `settings.yaml` itself, but rejects this section as a whole because its
 * `channels` key collides with the non-volatile channel list, which would drop every binding and
 * owner. The Host renames the file to `settings.yaml.imported` around the same time, so read both.
 * @param scope - state scope to write into.
 * @param profileHome - active profile home, or undefined when the Host does not expose one.
 * @param logger - plugin logger.
 */
export async function migrateLegacyState(
  scope: StateScope,
  profileHome: string | undefined,
  logger: { info(msg: string): void; warn(msg: string): void },
): Promise<void> {
  if (profileHome === undefined) return
  const current = scope.get()
  if (STATE_KEYS.some((key) => Object.keys(current[key] ?? {}).length > 0)) return
  for (const file of ['settings.yaml', 'settings.yaml.imported']) {
    let text: string
    try {
      text = await readFile(join(profileHome, file), 'utf8')
    } catch {
      continue
    }
    try {
      const section = (yaml.load(text) as Record<string, unknown> | null)?.['qq-weixin'] as Record<string, unknown> | undefined
      if (!section || typeof section !== 'object') return
      const doc: Partial<StateDoc> = {}
      for (const key of STATE_KEYS) if (isStringDict(section[key])) doc[key] = section[key]
      if (Object.keys(doc).length === 0) return
      await scope.update(doc)
      logger.info(`[qq-weixin] imported bindings and sessions from ${file}`)
    } catch (error) {
      logger.warn(`[qq-weixin] could not import state from ${file}: ${String(error)}`)
    }
    return
  }
}
