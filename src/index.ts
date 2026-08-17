/**
 * dsh-qq-weixin 插件入口（Host 半边）。
 *
 * 接线：QQ/微信真实通道适配器 → AgentManager（创建/恢复 Agent）→
 * InboundTracker（MessageId/turn 关联）→ 通道回发；审批/提问桥；
 * /qqbot JSON-RPC（状态/开始绑定/二维码/验证码/取消绑定/断开）；
 * credentials 引用式秘密；settings 持久化会话映射。
 *
 * 生命周期：ctx.on/ctx.timeout/ctx.effect 全部挂在插件 fiber 上，插件
 * 卸载（stop/undefine/进程退出）时按 LIFO 逆序自动清理；我们创建的 Agent
 * 由 agent-loop 以 ownerCtx=本插件 ctx 注册，卸载时一并 dispose。
 */

import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { APPROVAL_POLICIES } from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'

import type { ChannelAdapter, ChannelKind, ChannelReplyStream, ChannelStatus } from './channel.js'
import { bindingKeyFor } from './channel.js'
import type {
  AgentHandleLike,
  AgentLike,
  CreateAgentOptionsLike,
  DefaultModelLike,
  PresetsLike,
  ResumeAgentOptionsLike,
} from './agent-bridge.js'
import { AgentManager, buildInboundMessage } from './agent-bridge.js'
import { InboundTracker, describeTurnReason } from './correlation.js'
import type { SessionEventLike } from './correlation.js'
import { installApprovalAnswerer, installQuestionProvider } from './approval-bridge.js'
import type { OwnerInfo } from './approval-bridge.js'
import { SidecarChannelAdapter, type PersistedChannelBinding } from './sidecar-channel.js'
import { TelegramChannelAdapter } from './telegram-channel.js'
import { FeishuChannelAdapter } from './feishu-channel.js'
import { WecomChannelAdapter } from './wecom-channel.js'
import { installBindPage, type BindPage } from './bind-page.js'
import { BRIDGE_HELP, formatTokenCount, parseBridgeCommand, safetyLabel } from './commands.js'

export const name = 'qq-weixin'

export const inject = ['agents', 'approval', 'permissionPresets', 'llm', 'userQuestions', 'settings', 'credentials', 'timer', 'tools']

export interface PluginConfig {
  readonly channels: string[]
  readonly sharedSession: boolean
  readonly preset: string
  readonly cwd: string
  readonly stateDir: string
  readonly sourceKind: 'user' | ChannelKind
  readonly approvalPolicy: 'ask' | 'never'
  readonly replyTimeoutMs: number
  /** Hide local absolute workspace paths before sending text to IM platforms. */
  readonly redactWorkspacePaths: boolean
}

export const Config = z.object({
  channels: z.array(z.string()).default(['qq', 'wechat', 'wecom', 'feishu', 'telegram']),
  sharedSession: z.boolean().default(false),
  preset: z.string().default(''),
  cwd: z.string().default(''),
  stateDir: z.string().default(''),
  sourceKind: z.union(['user', 'qq', 'wechat', 'wecom', 'feishu', 'telegram']).default('user'),
  approvalPolicy: z.union(['ask', 'never']).default('ask'),
  replyTimeoutMs: z.number().min(0).default(0),
  redactWorkspacePaths: z.boolean().default(true),
})

/** settings 命名空间：channel/user → sessionId 的持久化映射。 */
const SETTINGS_NS = settingsNamespace('qq-weixin')
const SETTINGS_SCHEMA = z.object({
  bindings: z.dict(z.string()).default({}),
  channels: z.dict(z.string()).default({}),
  sessions: z.dict(z.string()).default({}),
  histories: z.dict(z.string()).default({}),
  workspaces: z.dict(z.string()).default({}),
  efforts: z.dict(z.string()).default({}),
  models: z.dict(z.string()).default({}),
})

/** credentials 只存引用（环境变量形状的 ref），值由提供方持有。 */
const QQ_SECRET_REF = credentialRef('DSH_QQ_APP_SECRET')
const WEIXIN_TOKEN_REF = credentialRef('DSH_WEIXIN_BOT_TOKEN')
const TELEGRAM_TOKEN_REF = credentialRef('DSH_TELEGRAM_BOT_TOKEN')
const FEISHU_APP_ID_REF = credentialRef('DSH_FEISHU_APP_ID')
const FEISHU_APP_SECRET_REF = credentialRef('DSH_FEISHU_APP_SECRET')
const WECOM_BOT_ID_REF = credentialRef('DSH_WECOM_BOT_ID')
const WECOM_BOT_SECRET_REF = credentialRef('DSH_WECOM_BOT_SECRET')

/* --------------------------- Host ctx 结构视图 --------------------------- */
interface HostCtx {
  logger: {
    info(msg: string, ...rest: unknown[]): void
    warn(msg: string, ...rest: unknown[]): void
    error(msg: string, ...rest: unknown[]): void
  }
  agents: {
    create(options: CreateAgentOptionsLike): Promise<AgentHandleLike>
    resume(options: ResumeAgentOptionsLike): Promise<AgentHandleLike>
    get(id: SessionId): AgentLike | undefined
  }
  settings: {
    register(namespace: string, schema: unknown): {
      get(): unknown
      update(patch: unknown): Promise<void>
    }
  }
  credentials: {
    describe(ref: string): Promise<{ configured: boolean; writable: boolean }>
    resolve(ref: string): Promise<{ value: string; source: string } | undefined>
    set(ref: string, value: string): Promise<void>
    unset(ref: string): Promise<void>
  }
  userQuestions: { registerProvider(provider: unknown): () => void }
  permissionPresets: {
    readonly names: readonly string[]
    readonly defaultPreset: string
    current(events: readonly unknown[]): string
    set(session: unknown, name: string): void
  }
  llm: {
    listProviders(): ReadonlyArray<{ id: string; name: string }>
    listModels(provider: string): Promise<ReadonlyArray<{ provider: string; id: string; name: string; description?: string }>>
    resolveModelInfo(provider: string, model: string): Promise<{
      name?: string
      context?: { contextWindow: number }
      reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string }
    }>
  }
  tools: { register(tool: unknown): () => void }
  timeout(callback: () => void, ms: number): () => void
  on(name: string, listener: (...args: any[]) => unknown): () => void
  effect(fn: () => unknown, label?: string): unknown
  get<T = unknown>(name: string): T | undefined
}

interface RpcOk {
  ok: true
  value: unknown
}
interface RpcErr {
  ok: false
  error: { code: string; message: string; details?: Record<string, unknown> }
}
type RpcResult = RpcOk | RpcErr

const ok = (value: unknown): RpcOk => ({ ok: true, value })
const err = (code: string, message: string, details?: Record<string, unknown>): RpcErr => ({
  ok: false,
  error: { code, message, ...(details !== undefined ? { details } : {}) },
})

/* -------------------------------------------------------------------------- */
export function apply(ctx: HostCtx, config: PluginConfig): void {
  const logger = ctx.logger

  if (!APPROVAL_POLICIES.includes(config.approvalPolicy)) {
    throw new Error(`qq-weixin: invalid approvalPolicy ${JSON.stringify(config.approvalPolicy)}`)
  }

  /* ---- settings 命名空间（会话映射持久化） ---- */
  const settingsScope = ctx.settings.register(SETTINGS_NS, SETTINGS_SCHEMA)
  interface SettingsDoc {
    bindings: Record<string, string>
    channels: Record<string, string>
    sessions: Record<string, string>
    histories: Record<string, string>
    workspaces: Record<string, string>
    efforts: Record<string, string>
    models: Record<string, string>
  }
  interface ManagedSession {
    id: string
    name: string
    cwd: string
    createdAt: number
    lastUsedAt: number
  }
  let settingsCache: SettingsDoc = {
    bindings: {}, channels: {}, sessions: {}, histories: {}, workspaces: {}, efforts: {}, models: {},
  }
  async function readSettings(): Promise<SettingsDoc> {
    const resolved = settingsScope.get() as Partial<SettingsDoc> | undefined
    return {
      bindings: { ...(resolved?.bindings ?? {}) },
      channels: { ...(resolved?.channels ?? {}) },
      sessions: { ...(resolved?.sessions ?? {}) },
      histories: { ...(resolved?.histories ?? {}) },
      workspaces: { ...(resolved?.workspaces ?? {}) },
      efforts: { ...(resolved?.efforts ?? {}) },
      models: { ...(resolved?.models ?? {}) },
    }
  }
  const settingsReady = readSettings().then((settings) => {
    settingsCache = settings
  })
  async function persistBinding(key: string, sessionId: string): Promise<void> {
    const { bindings } = await readSettings()
    bindings[key] = sessionId
    settingsCache.bindings[key] = sessionId
    await settingsScope.update({ bindings })
  }
  function sessionHistory(key: string): string[] {
    try {
      const value = JSON.parse(settingsCache.histories[key] ?? '[]')
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }
  function sessionMeta(id: string): ManagedSession | undefined {
    try {
      const value = JSON.parse(settingsCache.sessions[id] ?? '') as ManagedSession
      return value?.id === id ? value : undefined
    } catch {
      return undefined
    }
  }
  async function recordSession(key: string, id: string, cwd: string, name?: string): Promise<void> {
    const current = await readSettings()
    const now = Date.now()
    const old = sessionMeta(id)
    const meta: ManagedSession = {
      id,
      name: name?.trim() || old?.name || `会话 ${new Date(now).toLocaleString('zh-CN')}`,
      cwd: cwd || old?.cwd || config.cwd || process.cwd(),
      createdAt: old?.createdAt ?? now,
      lastUsedAt: now,
    }
    const history = sessionHistory(key).filter((item) => item !== id)
    history.unshift(id)
    current.sessions[id] = JSON.stringify(meta)
    current.histories[key] = JSON.stringify(history.slice(0, 30))
    settingsCache.sessions[id] = current.sessions[id]!
    settingsCache.histories[key] = current.histories[key]!
    await settingsScope.update({ sessions: current.sessions, histories: current.histories })
  }
  async function replaceSessionRecord(key: string, oldId: string | undefined, newId: string, cwd: string, name: string): Promise<void> {
    const current = await readSettings()
    const now = Date.now()
    if (oldId !== undefined) {
      delete current.sessions[oldId]
      delete current.efforts[oldId]
      delete current.models[oldId]
      delete settingsCache.sessions[oldId]
      delete settingsCache.efforts[oldId]
      delete settingsCache.models[oldId]
    }
    const meta: ManagedSession = { id: newId, name, cwd, createdAt: now, lastUsedAt: now }
    current.sessions[newId] = JSON.stringify(meta)
    current.histories[key] = JSON.stringify([newId, ...sessionHistory(key).filter((id) => id !== oldId && id !== newId)].slice(0, 30))
    settingsCache.sessions[newId] = current.sessions[newId]!
    settingsCache.histories[key] = current.histories[key]!
    await settingsScope.update({ sessions: current.sessions, histories: current.histories, efforts: current.efforts, models: current.models })
  }
  async function removeBinding(channel: ChannelKind, userId: string | undefined): Promise<void> {
    if (config.sharedSession) return
    if (userId === undefined) return
    const key = bindingKeyFor(channel, userId, false)
    const { bindings } = await readSettings()
    if (bindings[key] !== undefined) {
      delete bindings[key]
      delete settingsCache.bindings[key]
      await settingsScope.update({ bindings })
    }
  }

  function channelPersistence(kind: ChannelKind) {
    return {
      load(): PersistedChannelBinding | undefined {
        const raw = settingsCache.channels[kind]
        if (raw === undefined) return undefined
        try {
          const parsed = JSON.parse(raw) as PersistedChannelBinding
          return parsed.accountId && ((kind === 'qq' || kind === 'wechat' || kind === 'wecom') ? parsed.ownerUserId : true) ? parsed : undefined
        } catch {
          return undefined
        }
      },
      async save(binding: PersistedChannelBinding): Promise<void> {
        const { channels } = await readSettings()
        channels[kind] = JSON.stringify(binding)
        settingsCache.channels[kind] = channels[kind]!
        await settingsScope.update({ channels })
      },
      async clear(): Promise<void> {
        const { channels } = await readSettings()
        delete channels[kind]
        delete settingsCache.channels[kind]
        await settingsScope.update({ channels })
      },
    }
  }

  /* ---- Real QQ Gateway / Weixin iLink adapters ---- */
  const adapters = new Map<ChannelKind, ChannelAdapter>()
  for (const configuredChannel of config.channels) {
    const channel = configuredChannel === 'weixin' ? 'wechat' : configuredChannel as ChannelKind
    if (!['qq', 'wechat', 'wecom', 'feishu', 'telegram'].includes(channel)) continue
    const baseStateDir = config.stateDir === ''
      ? dshHomePath('qq-weixin')
      : resolve(config.stateDir)
    if (channel === 'qq' || channel === 'wechat') {
      adapters.set(channel, new SidecarChannelAdapter({ kind: channel, profileId: 'default', stateDir: join(baseStateDir, channel), secretRef: channel === 'qq' ? QQ_SECRET_REF : WEIXIN_TOKEN_REF, credentials: ctx.credentials, persistence: channelPersistence(channel), logger }))
    } else if (channel === 'telegram') {
      adapters.set(channel, new TelegramChannelAdapter({ tokenRef: TELEGRAM_TOKEN_REF, credentials: ctx.credentials, persistence: channelPersistence(channel), logger }))
    } else if (channel === 'wecom') {
      adapters.set(channel, new WecomChannelAdapter({ botIdRef: WECOM_BOT_ID_REF, secretRef: WECOM_BOT_SECRET_REF, credentials: ctx.credentials, persistence: channelPersistence(channel), logger }))
    } else {
      adapters.set(channel, new FeishuChannelAdapter({ appIdRef: FEISHU_APP_ID_REF, appSecretRef: FEISHU_APP_SECRET_REF, credentials: ctx.credentials, persistence: channelPersistence(channel), logger }))
    }
  }

  /* ---- 可选服务 ---- */
  const presets = ctx.get<PresetsLike>('agentPresets')
  const defaultModel = ctx.get<DefaultModelLike>('agentDefaultModel')

  let resolvedPresetId: string | undefined
  async function resolvePresetId(): Promise<string | undefined> {
    if (resolvedPresetId !== undefined) return resolvedPresetId
    if (presets === undefined) {
      resolvedPresetId = undefined
      return undefined
    }
    // undefined deliberately means the deployment default preset.
    const resolved = await presets.resolve(config.preset === '' ? undefined : config.preset)
    resolvedPresetId = resolved.id
    return resolvedPresetId
  }

  const manager = new AgentManager(
    { create: (o) => ctx.agents.create(o), resume: (o) => ctx.agents.resume(o), get: (id) => ctx.agents.get(id) },
    {
      sharedSession: config.sharedSession,
      cwd: config.cwd === '' ? process.cwd() : config.cwd,
      approvalPolicy: config.approvalPolicy,
      presets,
      defaultModel,
      getModelSelection: storedModel,
      getBinding: (key) => settingsCache.bindings[key],
      persistBinding,
      logger,
    },
  )

  const ownerBySession = new Map<string, OwnerInfo>()

  /* ---- 入站 → Agent → 关联 → 回发 ---- */
  const tracker = new InboundTracker()

  const conversationKey = (channel: ChannelKind, userId: string) =>
    bindingKeyFor(channel, userId, config.sharedSession)
  const defaultCwd = () => config.cwd === '' ? process.cwd() : resolve(config.cwd)
  const activeCwd = (key: string) => settingsCache.workspaces[key] ?? defaultCwd()

  /**
   * An IM reply is often forwarded outside the machine running Harness.  Keep
   * the real cwd for Agent execution, but do not disclose it in command cards
   * or model output unless an operator explicitly opts in.
   */
  function redactExternalText(text: string): string {
    if (!config.redactWorkspacePaths || text === '') return text

    const paths = new Set<string>([defaultCwd(), process.cwd(), config.cwd])
    for (const cwd of Object.values(settingsCache.workspaces)) paths.add(cwd)
    for (const raw of Object.values(settingsCache.sessions)) {
      try {
        const cwd = (JSON.parse(raw) as Partial<ManagedSession>).cwd
        if (typeof cwd === 'string') paths.add(cwd)
      } catch { /* Ignore malformed legacy session metadata. */ }
    }

    const variants = new Set<string>()
    for (const path of paths) {
      const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      if (normalized.length < 3) continue
      variants.add(path)
      variants.add(normalized)
      const windows = /^([A-Za-z]):\/(.+)$/.exec(normalized)
      if (windows) variants.add(`/mnt/${windows[1]!.toLowerCase()}/${windows[2]}`)
      const wsl = /^\/mnt\/([A-Za-z])\/(.+)$/.exec(normalized)
      if (wsl) variants.add(`${wsl[1]!.toUpperCase()}:\\${wsl[2]!.replace(/\//g, '\\')}`)
    }

    let result = text
    for (const path of [...variants].sort((a, b) => b.length - a.length)) {
      result = result.split(path).join('当前工作区')
    }
    return result
  }

  /** Apply path redaction to normal and native-streaming responses uniformly. */
  function protectExternalAdapter(adapter: ChannelAdapter): ChannelAdapter {
    const sendText = adapter.sendText.bind(adapter)
    const openReplyStream = adapter.openReplyStream?.bind(adapter)
    return new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === 'sendText') {
          return (userId: string, text: string, replyToId?: string) =>
            sendText(userId, redactExternalText(text), replyToId)
        }
        if (property === 'openReplyStream') {
          if (openReplyStream === undefined) return undefined
          return async (userId: string, replyToId: string): Promise<ChannelReplyStream | undefined> => {
            const stream = await openReplyStream(userId, replyToId)
            if (stream === undefined) return undefined
            return {
              update: (value) => stream.update(redactExternalText(value)),
              finish: (value) => stream.finish(redactExternalText(value)),
              cancel: () => stream.cancel(),
            }
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  for (const [kind, adapter] of adapters) adapters.set(kind, protectExternalAdapter(adapter))

  async function setWorkspace(key: string, cwd: string): Promise<void> {
    const { workspaces } = await readSettings()
    workspaces[key] = cwd
    settingsCache.workspaces[key] = cwd
    await settingsScope.update({ workspaces })
  }

  async function setEffort(sessionId: string, effort: string): Promise<void> {
    const { efforts } = await readSettings()
    efforts[sessionId] = effort
    settingsCache.efforts[sessionId] = effort
    await settingsScope.update({ efforts })
  }

  interface SessionModelSelection { provider: string; model: string }
  function storedModel(sessionId: string): SessionModelSelection | undefined {
    try {
      const value = JSON.parse(settingsCache.models[sessionId] ?? '') as Partial<SessionModelSelection>
      return value.provider && value.model ? { provider: value.provider, model: value.model } : undefined
    } catch { return undefined }
  }
  function currentModel(agent: AgentLike, sessionId: string): SessionModelSelection | undefined {
    const stored = storedModel(sessionId)
    if (stored !== undefined) return stored
    for (const event of [...agent.session.events].reverse()) {
      if (event.type === 'request/header' && event.data.config?.provider && event.data.config.model) {
        return { provider: event.data.config.provider, model: event.data.config.model }
      }
    }
    if (agent.options?.provider && agent.options.model) return { provider: agent.options.provider, model: agent.options.model }
    return defaultModel?.currentSelection()
  }
  async function setSessionModel(sessionId: string, selection: SessionModelSelection): Promise<void> {
    const { models } = await readSettings()
    models[sessionId] = JSON.stringify(selection)
    settingsCache.models[sessionId] = models[sessionId]!
    await settingsScope.update({ models })
  }
  async function modelCatalog(): Promise<Array<{ provider: string; providerName: string; id: string; name: string }>> {
    const groups = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
      try {
        const models = await ctx.llm.listModels(provider.id)
        return models.map((model) => ({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name }))
      } catch (error) {
        logger.warn(`[qq-weixin] model catalog failed for ${provider.id}: ${String(error)}`)
        return []
      }
    }))
    return groups.flat()
  }

  async function newSessionCard(input: {
    agent: AgentLike
    sessionId: string
    name: string
    cwd: string
    intro?: string
  }): Promise<string> {
    const selection = currentModel(input.agent, input.sessionId)
    let context: number | undefined
    const defaults = defaultModel?.currentSelection()
    let detectedEffort = selection !== undefined && defaults?.provider === selection.provider && defaults.model === selection.model
      ? defaults.reasoningEffort
      : undefined
    if (selection !== undefined) {
      try {
        const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
        context = info.context?.contextWindow
        detectedEffort ??= info.reasoning?.defaultEffort
      } catch (error) {
        logger.warn(`[qq-weixin] model metadata lookup failed: ${String(error)}`)
      }
    }
    const safety = ctx.permissionPresets.current(input.agent.session.events)
    const effort = settingsCache.efforts[input.sessionId] ?? detectedEffort ?? '模型默认'
    return [
      input.intro ?? '✨ 新会话已启动，从头开始。',
      '',
      `◆ 名称：${input.name}`,
      `◆ ID：${input.sessionId.slice(-8)}`,
      `◆ 项目：${input.cwd}`,
      ...(selection === undefined ? [] : [
        `◆ 模型：${selection.model}`,
        `◆ Provider：${selection.provider}`,
      ]),
      ...(context === undefined ? [] : [`◆ 上下文：${formatTokenCount(context)}（已检测）`]),
      `◆ 思考：${effort}`,
      `◆ 安全：${safetyLabel(safety)}`,
      '',
      '✦ 提示：发送 /help 可查看项目、会话、思考和安全命令。',
    ].join('\n')
  }

  async function controlCommand(
    adapter: ChannelAdapter,
    userId: string,
    text: string,
  ): Promise<boolean> {
    const command = parseBridgeCommand(text)
    if (command === undefined) return false
    await settingsReady
    const key = conversationKey(adapter.kind, userId)
    const send = (value: string) => adapter.sendText(userId, value)
    const presetId = await resolvePresetId()
    const ensure = async () => {
      const result = await manager.ensure(adapter.kind, userId, presetId, { cwd: activeCwd(key) })
      ownerBySession.set(result.sessionId, { channel: adapter.kind, userId })
      if (result.created || sessionMeta(result.sessionId) === undefined) {
        await recordSession(key, result.sessionId, activeCwd(key))
      }
      return result
    }

    switch (command.kind) {
      case 'help':
        await send(BRIDGE_HELP)
        return true
      case 'unknown':
        await send(`未知命令 /${command.name}\n发送 /help 查看命令`)
        return true
      case 'status': {
        const { agent, sessionId } = await ensure()
        const meta = sessionMeta(sessionId)
        const safety = ctx.permissionPresets.current(agent.session.events)
        const model = currentModel(agent, sessionId)
        const defaults = defaultModel?.currentSelection()
        const inheritedEffort = model !== undefined && defaults?.provider === model.provider && defaults.model === model.model
          ? defaults.reasoningEffort
          : undefined
        const effort = settingsCache.efforts[sessionId] ?? inheritedEffort ?? '模型默认'
        await send([
          `项目：${meta?.cwd ?? activeCwd(key)}`,
          `会话：${meta?.name ?? '未命名'}  #${sessionId.slice(-8)}`,
          `状态：${agent.status === 'running' ? '运行中' : '空闲'}`,
          `模型：${model === undefined ? '未配置' : `${model.provider}/${model.model}`}`,
          `思考：${effort}`,
          `安全：${safetyLabel(safety)}`,
        ].join('\n'))
        return true
      }
      case 'new': {
        const result = await manager.createFresh(adapter.kind, userId, presetId, activeCwd(key))
        ownerBySession.set(result.sessionId, { channel: adapter.kind, userId })
        await recordSession(key, result.sessionId, activeCwd(key), command.name)
        await send(await newSessionCard({
          agent: result.agent,
          sessionId: result.sessionId,
          name: sessionMeta(result.sessionId)?.name ?? command.name ?? '新会话',
          cwd: activeCwd(key),
        }))
        return true
      }
      case 'reset': {
        const oldId = settingsCache.bindings[key]
        const oldResult = oldId === undefined ? undefined : await ensure()
        const oldMeta = oldId === undefined ? undefined : sessionMeta(oldId)
        const cwd = oldMeta?.cwd ?? activeCwd(key)
        const name = oldMeta?.name ?? '新会话'
        const safety = oldResult === undefined ? undefined : ctx.permissionPresets.current(oldResult.agent.session.events)
        const effort = oldId === undefined ? undefined : settingsCache.efforts[oldId]
        const model = oldResult === undefined ? undefined : currentModel(oldResult.agent, oldResult.sessionId)
        const result = await manager.createFresh(adapter.kind, userId, presetId, cwd, model)
        if (safety !== undefined) ctx.permissionPresets.set(result.agent.session, safety)
        if (effort !== undefined) await setEffort(result.sessionId, effort)
        if (model !== undefined) await setSessionModel(result.sessionId, model)
        ownerBySession.set(result.sessionId, { channel: adapter.kind, userId })
        await replaceSessionRecord(key, oldId, result.sessionId, cwd, name)
        if (oldId !== undefined) {
          tracker.dropSession(oldId)
          ownerBySession.delete(oldId)
          await manager.disposeOwned(oldId).catch((error) => logger.warn(`[qq-weixin] reset could not dispose old agent ${oldId}: ${String(error)}`))
        }
        await send(await newSessionCard({
          agent: result.agent,
          sessionId: result.sessionId,
          name,
          cwd,
          intro: '♻️ 当前会话已重置，上下文已清空。',
        }))
        return true
      }
      case 'model': {
        const { agent, sessionId } = await ensure()
        const current = currentModel(agent, sessionId)
        const catalog = await modelCatalog()
        if (command.selector === undefined) {
          const shown = catalog.slice(0, 40)
          const rows = shown.map((item, index) => {
            const active = current?.provider === item.provider && current.model === item.id ? '▶' : ' '
            const label = item.name === item.id ? item.id : `${item.name} (${item.id})`
            return `${active} ${index + 1}. ${item.provider}/${label}`
          })
          await send([
            `当前模型：${current === undefined ? '未配置' : `${current.provider}/${current.model}`}`,
            '',
            ...(rows.length ? rows : ['当前没有可枚举的模型。']),
            ...(catalog.length > shown.length ? [`…另有 ${catalog.length - shown.length} 个模型，请用 provider/model 直接指定。`] : []),
            '',
            '切换：/model <编号或 provider/model>',
          ].join('\n'))
          return true
        }
        const selector = command.selector.trim()
        let selected: SessionModelSelection | undefined
        if (/^\d+$/.test(selector)) {
          const item = catalog[Number(selector) - 1]
          if (item !== undefined) selected = { provider: item.provider, model: item.id }
        } else {
          const inherited = !selector.includes('/') && current !== undefined
            ? catalog.filter((item) => item.provider === current.provider &&
              (item.id.toLowerCase() === selector.toLowerCase() || item.name.toLowerCase() === selector.toLowerCase()))
            : []
          const exactRoute = catalog.filter((item) => `${item.provider}/${item.id}`.toLowerCase() === selector.toLowerCase())
          const short = catalog.filter((item) => item.id.toLowerCase() === selector.toLowerCase() || item.name.toLowerCase() === selector.toLowerCase())
          const matches = inherited.length ? inherited : exactRoute.length ? exactRoute : current === undefined ? short : []
          if (matches.length === 1) selected = { provider: matches[0]!.provider, model: matches[0]!.id }
          if (selected === undefined && selector.includes('/')) {
            const slash = selector.indexOf('/')
            selected = { provider: selector.slice(0, slash), model: selector.slice(slash + 1) }
          }
          if (selected === undefined && matches.length === 0 && !selector.includes('/') && current !== undefined) {
            selected = { provider: current.provider, model: selector }
          }
          if (matches.length > 1) {
            await send(`模型名称匹配到多个结果，请使用 provider/model：\n${matches.map((item) => `- ${item.provider}/${item.id}`).join('\n')}`)
            return true
          }
        }
        if (selected === undefined || !selected.provider || !selected.model) {
          await send('没有找到该模型。发送 /model 查看编号和名称。')
          return true
        }
        let info: Awaited<ReturnType<HostCtx['llm']['resolveModelInfo']>>
        try {
          info = await ctx.llm.resolveModelInfo(selected.provider, selected.model)
        } catch (error) {
          await send(`模型不可用：${selected.provider}/${selected.model}\n${error instanceof Error ? error.message : String(error)}`)
          return true
        }
        let effortNotice = ''
        const effort = settingsCache.efforts[sessionId]
        const preservedEffort = effort !== undefined && info.reasoning?.efforts.some((item) => item.id === effort)
          ? effort
          : undefined
        if (effort !== undefined && preservedEffort === undefined) {
          effortNotice = '\n原思考档位不受新模型支持，已恢复为模型默认。'
        }
        const meta = sessionMeta(sessionId)
        const cwd = meta?.cwd ?? activeCwd(key)
        const name = meta?.name ?? '新会话'
        const safety = ctx.permissionPresets.current(agent.session.events)
        let result: Awaited<ReturnType<typeof manager.forkWithModel>>
        try {
          result = await manager.forkWithModel(adapter.kind, userId, agent, selected, presetId, cwd)
        } catch (error) {
          await send(`模型切换失败，原会话仍可继续使用。\n${error instanceof Error ? error.message : String(error)}`)
          return true
        }
        ctx.permissionPresets.set(result.agent.session, safety)
        if (preservedEffort !== undefined) await setEffort(result.sessionId, preservedEffort)
        await setSessionModel(result.sessionId, selected)
        ownerBySession.set(result.sessionId, { channel: adapter.kind, userId })
        await replaceSessionRecord(key, sessionId, result.sessionId, cwd, name)
        tracker.dropSession(sessionId)
        ownerBySession.delete(sessionId)
        await manager.disposeOwned(sessionId).catch((error) => logger.warn(`[qq-weixin] model switch could not dispose old agent ${sessionId}: ${String(error)}`))
        await send([
          `模型已切换：${info.name ?? selected.model}`,
          `路由：${selected.provider}/${selected.model}`,
          ...(info.context === undefined ? [] : [`上下文：${formatTokenCount(info.context.contextWindow)}`]),
          '立即生效，当前对话上下文已保留。',
        ].join('\n') + effortNotice)
        return true
      }
      case 'work': {
        if (command.path === undefined) {
          await send(`当前项目：${activeCwd(key)}\n用法：/work <文件夹路径>`)
          return true
        }
        const cwd = resolve(activeCwd(key), command.path)
        const info = await stat(cwd).catch(() => undefined)
        if (info?.isDirectory() !== true) {
          await send(`项目文件夹不存在：${cwd}`)
          return true
        }
        await setWorkspace(key, cwd)
        const result = await manager.createFresh(adapter.kind, userId, presetId, cwd)
        ownerBySession.set(result.sessionId, { channel: adapter.kind, userId })
        await recordSession(key, result.sessionId, cwd, cwd.split(/[\\/]/).filter(Boolean).at(-1))
        await send(await newSessionCard({
          agent: result.agent,
          sessionId: result.sessionId,
          name: sessionMeta(result.sessionId)?.name ?? '新会话',
          cwd,
        }))
        return true
      }
      case 'list': {
        const active = settingsCache.bindings[key]
        const rows = sessionHistory(key).map((id, index) => {
          const meta = sessionMeta(id)
          return `${id === active ? '▶' : ' '} ${index + 1}. ${meta?.name ?? '未命名'}  #${id.slice(-8)}\n   ${meta?.cwd ?? ''}`
        })
        await send(rows.length === 0 ? '还没有会话。发送 /new 新建。' : `会话列表（/use 序号）\n${rows.join('\n')}`)
        return true
      }
      case 'use': {
        if (command.selector === undefined) {
          await send('用法：/use <序号或ID>\n先发送 /list 查看会话')
          return true
        }
        const history = sessionHistory(key)
        const numeric = /^\d+$/.test(command.selector) ? Number(command.selector) : 0
        const matches = numeric > 0
          ? [history[numeric - 1]].filter((id): id is string => id !== undefined)
          : history.filter((id) => id === command.selector || id.endsWith(command.selector!))
        if (matches.length !== 1) {
          await send(matches.length === 0 ? '没找到该会话。发送 /list 查看。' : 'ID 匹配到多个会话，请输入更完整的 ID。')
          return true
        }
        const selectedMeta = sessionMeta(matches[0]!)
        if (selectedMeta?.cwd !== undefined) await setWorkspace(key, selectedMeta.cwd)
        await manager.select(adapter.kind, userId, matches[0]!)
        const result = await ensure()
        await recordSession(key, result.sessionId, sessionMeta(result.sessionId)?.cwd ?? activeCwd(key))
        const meta = sessionMeta(result.sessionId)
        await send(`已切换会话：${meta?.name ?? result.sessionId.slice(-8)}\n项目：${meta?.cwd ?? activeCwd(key)}`)
        return true
      }
      case 'stop': {
        const id = settingsCache.bindings[key]
        const agent = id === undefined ? undefined : ctx.agents.get(SessionId(id))
        if (agent === undefined || agent.status !== 'running') {
          await send('当前没有正在运行的任务。')
        } else {
          agent.cancel({ kind: 'user' })
          await send('已停止当前任务。')
        }
        return true
      }
      case 'think': {
        const { agent, sessionId } = await ensure()
        const selection = currentModel(agent, sessionId)
        if (selection === undefined) {
          await send('当前部署没有可读取的模型设置。')
          return true
        }
        const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
        const efforts = info.reasoning?.efforts ?? []
        const defaults = defaultModel?.currentSelection()
        const inherited = defaults?.provider === selection.provider && defaults.model === selection.model ? defaults.reasoningEffort : undefined
        const current = settingsCache.efforts[sessionId] ?? inherited ?? info.reasoning?.defaultEffort
        if (command.effort === undefined) {
          await send(`思考强度：${current ?? '模型默认'}\n可选：${efforts.map((item) => item.id).join(' / ') || '当前模型不支持调整'}\n用法：/think <强度>`)
          return true
        }
        if (!efforts.some((item) => item.id === command.effort)) {
          await send(`当前模型不支持 ${command.effort}\n可选：${efforts.map((item) => item.id).join(' / ') || '无'}`)
          return true
        }
        await setEffort(sessionId, command.effort)
        await send(`思考强度已设为：${command.effort}\n从下一次模型请求生效。`)
        return true
      }
      case 'safe': {
        const { agent } = await ensure()
        const current = ctx.permissionPresets.current(agent.session.events)
        if (command.preset === undefined) {
          await send(`安全等级：${safetyLabel(current)}\n可选：只读 / 写入 / 完全\n用法：/safe <等级>`)
          return true
        }
        if (!ctx.permissionPresets.names.includes(command.preset)) {
          await send(`当前部署不提供安全等级：${command.preset}`)
          return true
        }
        ctx.permissionPresets.set(agent.session, command.preset)
        await send(`安全等级已设为：${safetyLabel(command.preset)}${command.preset === 'danger-full-access' ? '\n注意：完全访问不再弹出安全审核。' : '\n越权操作会在当前聊天平台中请求审核。'}`)
        return true
      }
    }
    return true
  }

  async function handleInbound(
    adapter: ChannelAdapter,
    userId: string,
    extId: string,
    text: string,
  ): Promise<void> {
    try {
      if (await controlCommand(adapter, userId, text)) return
      await resolvePresetId()
      await settingsReady
      const key = conversationKey(adapter.kind, userId)
      const { agent, sessionId, created } = await manager.ensure(
        adapter.kind, userId, resolvedPresetId, { cwd: activeCwd(key) },
      )
      if (created || !ownerBySession.has(sessionId)) {
        ownerBySession.set(sessionId, { channel: adapter.kind, userId })
      }
      if (created || sessionMeta(sessionId) === undefined) await recordSession(key, sessionId, activeCwd(key))
      const message = buildInboundMessage({
        channel: adapter.kind,
        userId,
        extId,
        text,
        sourceKind: config.sourceKind,
      })
      const tracked = tracker.register({
        extId,
        sessionId,
        channel: adapter.kind,
        userId,
        msgId: message.id,
      })
      await adapter.sendTyping?.(userId, extId).catch(() => undefined)
      if (adapter.openReplyStream !== undefined) {
        tracked.stream = await adapter.openReplyStream(userId, extId).catch((error) => {
          logger.warn(`[qq-weixin] ${adapter.kind} native stream unavailable: ${String(error)}`)
          return undefined
        })
      }
      agent.followup(message)
      if (config.replyTimeoutMs > 0) {
        tracked.timeout = ctx.timeout(() => {
          if (tracked.done) return
          tracker.remove(extId)
          void tracked.stream?.cancel()
          void adapter.sendText(userId, `⏱️ 超时（${config.replyTimeoutMs}ms），任务已放弃`)
        }, config.replyTimeoutMs)
      }
    } catch (error) {
      logger.warn(`[qq-weixin] inbound handling failed: ${String(error)}`)
      void adapter.sendText(userId, '⚠️ 处理失败，请稍后再试')
    }
  }

  for (const adapter of adapters.values()) {
    adapter.onInbound((message) => {
      void handleInbound(adapter, message.userId, message.extId, message.text)
    })
    void settingsReady.then(() => adapter.start()).catch((error) => {
      logger.warn(`[qq-weixin] ${adapter.kind} startup failed: ${String(error)}`)
    })
  }

  /* ---- 事件订阅（ctx.on 注册即 fiber effect，卸载自动移除） ---- */
  ctx.on('agent/request', async ({ agent }: any, next: () => Promise<Record<string, unknown>>) => {
    const base = await next()
    const effort = settingsCache.efforts[String(agent.id)]
    return {
      ...base,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }: any) => {
    tracker.onInboxClaimed(message.id, turn)
  })
  ctx.on('session/event', (session: any, event: SessionEventLike) => {
    if (event.type === 'assistant/chunk' && event.data?.turn !== undefined && event.data.chunk?.type === 'text-delta' && event.data.chunk.text) {
      for (const tracked of tracker.appendTextDelta(session.id, event.data.turn, event.data.chunk.text)) {
        void tracked.stream?.update(tracked.streamText)
      }
    }
    if (event.type === 'assistant/message' && event.data?.turn !== undefined) {
      const text = (event.data.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      if (text) for (const tracked of tracker.setAssistantText(session.id, event.data.turn, text)) void tracked.stream?.update(text)
    }
    if (event.type === 'tool/call' && event.data?.turn !== undefined) {
      const callId = (event.data as { callId?: unknown }).callId
      if (typeof callId === 'string') tracker.onToolCall(session.id, callId, event.data.turn)
      const data = event.data as { name?: unknown; toolName?: unknown }
      const toolName = String(data.name ?? data.toolName ?? '工具')
      for (const tracked of tracker.activeForTurn(session.id, event.data.turn)) {
        void tracked.stream?.update(`${tracked.streamText}${tracked.streamText ? '\n\n' : ''}_正在使用 ${toolName}…_`)
      }
    }
    if (event.type === 'turn/end' && event.data?.turn !== undefined) {
      for (const tracked of tracker.onTurnEnd(session.id, event.data.turn, session.events)) {
        if (tracked.timeout !== undefined) {
          tracked.timeout()
          tracked.timeout = undefined
        }
        const adapter = adapters.get(tracked.channel)
        if (adapter !== undefined) {
          const payload = tracked.replyText !== '' ? tracked.replyText : describeTurnReason(tracked.reason)
          if (tracked.stream) void tracked.stream.finish(payload).catch(() => adapter.sendText(tracked.userId, payload, tracked.extId))
          else void adapter.sendText(tracked.userId, payload, tracked.extId)
        }
      }
    }
  })
  ctx.on('agent/error', ({ agent, turn, error }: any) => {
    // Use the claimed inbound address, rather than a session-global owner:
    // QQ and WeChat can share a session and run concurrent turns.
    for (const tracked of tracker.failTurn(agent.id, turn, { kind: 'error', error })) {
      tracked.timeout?.()
      const adapter = adapters.get(tracked.channel)
      if (adapter !== undefined) {
        void tracked.stream?.cancel()
        void adapter.sendText(tracked.userId, `⚠️ 回合 ${turn} 出错：${error?.message ?? String(error)}`)
      }
    }
  })
  ctx.on('agent/disposed', ({ agent }: any) => {
    tracker.dropSession(agent.id)
    ownerBySession.delete(agent.id)
  })

  /* ---- 审批 / 提问桥 ---- */
  const routeForRequest = (sessionId: string, callId?: string): OwnerInfo | undefined => {
    const active = callId === undefined
      ? tracker.routeForTurn(sessionId, undefined)
      : tracker.routeForCall(sessionId, callId)
    // With isolated sessions, agent.id is the official and sufficient route.
    // A shared session needs the active claimed turn to avoid cross-channel delivery.
    return active ?? (config.sharedSession ? undefined : ownerBySession.get(sessionId))
  }
  const stopApproval = installApprovalAnswerer(ctx, { adapters, ownerBySession, routeForRequest, logger })
  /* ---- userQuestions 单 provider seam 的共存策略 ----
   * web profile 的 api-gateway（dsh-host-apiproxy）启动时注册官方 provider，
   * 且本插件行总是先于 api-gateway 激活：若我们也注册，api-gateway 会以
   * DUPLICATE_PROVIDER 崩溃，整个插件树 fail-loud（webServer 存在 == 该 profile
   * 必然挂载 apiproxy）。因此 web profile 下我们**不注册**，ask_user_question
   * 由浏览器 UI 回答；web-free profile（headless/自定义）下我们注册，QQ/微信
   * 通道接收问题。正确解是上游把 seam 改成多 provider / 按 agent scope 路由。
   */
  const webServer = ctx.get<{ host: '127.0.0.1' | '0.0.0.0'; port: number; register(route: unknown): () => void }>('webServer')
  let stopQuestions: () => void = () => {}
  if (webServer === undefined) {
    try {
      stopQuestions = installQuestionProvider(ctx, { adapters, ownerBySession, routeForRequest, logger })
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'DUPLICATE_PROVIDER') {
        logger.warn('[qq-weixin] userQuestions provider 已被占用，ask_user_question 将改由其他 provider 回答')
      } else {
        throw error
      }
    }
  } else {
    logger.warn('[qq-weixin] 检测到 web profile（webServer）：userQuestions 单 provider seam 由 api-gateway 持有，' +
      'ask_user_question 将由浏览器 UI 回答；QQ/微信通道不接收问题（上游多 provider 修复前的权衡）')
  }

  /* ---- 扫码绑定独立页面 + qq_weixin_bind 工具（agent 无法收发图片 → 网页承载二维码） ---- */
  let page: BindPage | undefined
  if (webServer !== undefined) {
    page = installBindPage({ adapters, webServer, logger })
    ctx.tools.register(defineTool({
      name: 'qq_weixin_bind',
      description: '生成 QQ 或微信扫码绑定页面。返回一个 URL，人类用户用浏览器打开该页面即可看到二维码并扫码接入（当前 Agent 无法直接收发图片，二维码由独立网页承载）。channel 取 "qq" 或 "wechat"（"weixin" 为别名）。',
      parameters: {
        channel: {
          type: 'string',
          required: true,
          enum: ['qq', 'wechat', 'weixin'],
          description: '要绑定的渠道：qq（QQ 官方 Gateway）或 wechat（微信 iLink）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', description: '人类可打开的绑定页面 URL（内含二维码）。' },
            channel: { type: 'string' },
            token: { type: 'string', description: '页面会话凭证。' },
            state: { type: 'string', description: '绑定状态：awaiting-code / bound / starting。' },
            alreadyBound: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const channel: ChannelKind = args.channel === 'weixin' ? 'wechat' : args.channel as ChannelKind
        const adapter = adapters.get(channel)
        if (adapter === undefined) throw new Error(`qq-weixin: 渠道 ${args.channel} 未配置（channels: ${config.channels.join(', ')}）`)
        if (page === undefined) throw new Error('qq-weixin: 当前 profile 未提供 webServer，无法生成扫码绑定页面（需要 web profile）')
        const status = adapter.getStatus()
        if (status.state === 'bound') {
          const token = randomBytes(16).toString('hex')
          return {
            url: page.urlFor(token),
            channel,
            token,
            state: 'bound',
            alreadyBound: true,
            message: '该渠道已绑定；打开页面可查看连接状态。',
          }
        }
        const { token, url } = page.start(channel)
        return {
          url,
          channel,
          token,
          state: 'awaiting-code',
          message: '请在浏览器打开该 URL 扫码绑定。',
        }
      },
    }))
    logger.info('[qq-weixin] bind page ready at /qqbot-bind (tool: qq_weixin_bind)')
  }

  /* ---- /qqbot JSON-RPC（信任篱笆 + 信封校验由 connection 提供） ---- */
  async function statusSnapshot(): Promise<Record<string, unknown>> {
    const channels: Record<string, unknown> = {}
    for (const [kind, adapter] of adapters) {
      channels[kind] = { kind, status: adapter.getStatus() as ChannelStatus }
    }
    const { bindings } = await readSettings()
    const [token, secret, telegramToken, feishuAppId, feishuSecret, wecomBotId, wecomSecret] = await Promise.all([
      ctx.credentials.describe(QQ_SECRET_REF),
      ctx.credentials.describe(WEIXIN_TOKEN_REF),
      ctx.credentials.describe(TELEGRAM_TOKEN_REF),
      ctx.credentials.describe(FEISHU_APP_ID_REF),
      ctx.credentials.describe(FEISHU_APP_SECRET_REF),
      ctx.credentials.describe(WECOM_BOT_ID_REF),
      ctx.credentials.describe(WECOM_BOT_SECRET_REF),
    ])
    return {
      channels,
      sharedSession: config.sharedSession,
      sourceKind: config.sourceKind,
      approvalPolicy: config.approvalPolicy,
      sessionId: config.sharedSession ? bindings.shared : undefined,
      secrets: {
        [QQ_SECRET_REF]: token,
        [WEIXIN_TOKEN_REF]: secret,
        [TELEGRAM_TOKEN_REF]: telegramToken,
        [FEISHU_APP_ID_REF]: feishuAppId,
        [FEISHU_APP_SECRET_REF]: feishuSecret,
        [WECOM_BOT_ID_REF]: wecomBotId,
        [WECOM_BOT_SECRET_REF]: wecomSecret,
      },
    }
  }

  async function rpcDispatch(endpoint: string, payload: any): Promise<RpcResult> {
    try {
      switch (endpoint) {
        case 'status':
          return ok(await statusSnapshot())

        case 'configure': {
          const channel = payload?.channel as ChannelKind
          const adapter = adapters.get(channel)
          if (adapter?.configure === undefined) return err('bad-request', `channel ${String(channel)} does not use manual credentials`)
          const values = payload?.values
          if (values === null || typeof values !== 'object') return err('bad-request', 'missing credential values')
          await adapter.configure(values)
          return ok({ status: adapter.getStatus() })
        }

        case 'begin': {
          const channel = payload?.channel as ChannelKind
          const adapter = adapters.get(channel)
          if (adapter === undefined) return err('bad-request', `unknown channel ${String(channel)}`)
          const { qrDataUrl, code } = await adapter.startBinding()
          return ok({ qrDataUrl, code })
        }

        case 'verify': {
          const channel = payload?.channel as ChannelKind
          const code = payload?.code as string
          const adapter = adapters.get(channel)
          if (adapter === undefined) return err('bad-request', `unknown channel ${String(channel)}`)
          // Identity comes only from the signed platform binding result.  A
          // browser-supplied user id is intentionally ignored.
          const result = await adapter.submitCode('', code)
          if (!result.ok) return err('bad-code', result.error ?? '验证失败')
          return ok({ ok: true })
        }

        case 'unbind': {
          const channel = payload?.channel as ChannelKind
          const adapter = adapters.get(channel)
          if (adapter === undefined) return err('bad-request', `unknown channel ${String(channel)}`)
          const boundUserId = adapter.getStatus().boundUserId
          await adapter.unbind()
          await removeBinding(channel, boundUserId)
          return ok({ ok: true })
        }

        case 'disconnect': {
          const channel = payload?.channel as ChannelKind
          const adapter = adapters.get(channel)
          if (adapter === undefined) return err('bad-request', `unknown channel ${String(channel)}`)
          await adapter.stop()
          return ok({ ok: true })
        }

        case 'connect': {
          const channel = payload?.channel as ChannelKind
          const adapter = adapters.get(channel)
          if (adapter === undefined) return err('bad-request', `unknown channel ${String(channel)}`)
          await adapter.start()
          return ok({ status: adapter.getStatus() })
        }

        default:
          return err('bad-request', `unknown endpoint ${endpoint}`)
      }
    } catch (error) {
      logger.warn(`[qq-weixin] rpc ${endpoint} failed: ${String(error)}`)
      return err('internal', String(error))
    }
  }

  const connection = ctx.get<{ rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult>, options: { authority: 'loopback' }): () => void } }>('connection')
  const stopRpc = connection?.rpc.handle(
    '/qqbot',
    async (endpoint, payload) => rpcDispatch(endpoint, payload),
    { authority: 'loopback' },
  )

  /* ---- 卸载清理：LIFO；async disposer 会被 await；ctx.on 的监听器自动移除 ---- */
  ctx.effect(() => async () => {
    stopApproval()
    stopQuestions()
    stopRpc?.()
    page?.dispose()
    for (const adapter of adapters.values()) {
      await adapter.dispose()
    }
    tracker.clear()
    ownerBySession.clear()
    logger.info('[qq-weixin] plugin unloaded, adapters disposed')
  }, 'qq-weixin: lifecycle')
}
