/** Persistent Agent lifecycle using the public Harness 0.1.5-rc.2 contracts. */

import { randomBytes } from 'node:crypto'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ChannelKind } from './channel.js'
import { bindingKeyFor } from './channel.js'

/* ------------------------------------------------------------------ *
 * MessageSourceMap 扩展：加入 qq / wechat 两种来源 kind。
 *
 * - 类型层：TS 接口合并（declaration merging）在 MessageSourceMap 上追加
 *   两个成员，使 MessageSource 联合类型接受 qq/wechat（本包内生效）。
 * - 运行时：source.kind 是开放词表——第一方插件已使用 agent-instructions、
 *   skill-catalog、goal 等自定义 kind；会话日志只校验 JSON 可序列化，
 *   所有消费者都是 `kind === X` 的定向判断，未知 kind 只会被跳过，不会报错。
 * - 注意：dsh-tool-goal 的"直接人工输入"授权只认 kind === 'user'
 *   （dsh-tool-goal/lib/index.js:44-47）。若你的 Agent 使用 goal 工具的
 *   complete/blocked 授权，请把 sourceKind 配置为 user（默认，官方
 *   apiproxy 同款：{ kind:'user', channel, extId }）；qq/wechat kind 仅用于
 *   内部来源溯源。
 * ------------------------------------------------------------------ */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    qq: QqMessageSource
    wechat: WechatMessageSource
    wecom: WecomMessageSource
    feishu: FeishuMessageSource
    telegram: TelegramMessageSource
  }
}

export interface QqMessageSource {
  readonly kind: 'qq'
  readonly channel: 'qq'
  readonly userId: string
  readonly extId: string
}

export interface WechatMessageSource {
  readonly kind: 'wechat'
  readonly channel: 'wechat'
  readonly userId: string
  readonly extId: string
}

export interface WecomMessageSource {
  readonly kind: 'wecom'
  readonly channel: 'wecom'
  readonly userId: string
  readonly extId: string
}

export interface FeishuMessageSource {
  readonly kind: 'feishu'
  readonly channel: 'feishu'
  readonly userId: string
  readonly extId: string
}

export interface TelegramMessageSource {
  readonly kind: 'telegram'
  readonly channel: 'telegram'
  readonly userId: string
  readonly extId: string
}

export type SourceKind = 'user' | ChannelKind

/**
 * 用官方工厂 createUserMessage 构造带 MessageId 的 UserMessage。
 * sourceKind='user' 时 source 为 { kind:'user', channel, userId, extId }
 * （apiproxy 同款运行时形态；TS 侧因 { kind:'user' } 成员是精确类型而显式转型）；
 * sourceKind='qq'/'wechat' 时使用扩展的 MessageSourceMap kind。
 */
export function buildInboundMessage(input: {
  channel: ChannelKind
  userId: string
  extId: string
  text: string
  sourceKind: SourceKind
}): UserMessage {
  const provenance = { channel: input.channel, userId: input.userId, extId: input.extId }
  const source: MessageSource =
    input.sourceKind === 'user'
      ? ({ kind: 'user', ...provenance } as MessageSource)
      : ({ kind: input.sourceKind, ...provenance } as MessageSource)
  return createUserMessage({
    content: [{ type: 'text', text: input.text }],
    source,
  })
}

/* ------------------------------------------------------------------ *
 * ctx.agents 服务的结构视图（运行时由 @deepseek-ai/dsh-agent + dsh-agent-loop
 * 提供；create/resume 签名与 typert 注册表一致）。
 * ------------------------------------------------------------------ */
export type SessionLike = import('@deepseek-ai/dsh-session').Session
export type AgentLike = import('@deepseek-ai/dsh-agent').Agent
export type AgentSetupCommitLike = import('@deepseek-ai/dsh-agent').AgentSetupCommit
export type AgentHandleLike = import('@deepseek-ai/dsh-agent').AgentHandle
export type CreateAgentOptionsLike = import('@deepseek-ai/dsh-agent').CreateAgentOptions
export type ResumeAgentOptionsLike = import('@deepseek-ai/dsh-agent').ResumeAgentOptions
export type AgentsServiceLike = Pick<import('@deepseek-ai/dsh-agent').AgentRegistry, 'create' | 'resume' | 'get'>

export interface PresetsLike {
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentCtx: unknown, id: string): Promise<unknown>
}

export interface DefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

export interface AgentManagerOptions {
  readonly sharedSession: boolean
  readonly cwd?: string
  readonly approvalPolicy: 'ask' | 'never'
  readonly presets?: PresetsLike
  readonly defaultModel?: DefaultModelLike
  readonly getModelSelection?: (sessionId: string) => { provider: string; model: string } | undefined
  readonly getBinding: (key: string) => string | undefined
  readonly persistBinding: (key: string, sessionId: string) => Promise<void>
  readonly logger: { info(msg: string, ...rest: unknown[]): void; warn(msg: string, ...rest: unknown[]): void }
}

export interface EnsureAgentOptions {
  readonly cwd?: string
}

/**
 * 创建或恢复 Agent：
 * - 稳定 SessionId：`qq-weixin-<映射键>`（sharedSession 时键为 shared，否则
 *   <channel>:<userId>），跨重启不变；
 * - 已有持久化绑定 → resume；resume 失败（会话已不存在）→ 回退 create；
 * - setup 里挂载 preset（agentPresets.mount，失败回滚整个创建）并写入
 *   session approval policy，返回 AgentSetupCommit（在 publish 边界调用）。
 */
export class AgentManager {
  private readonly handles = new Map<string, AgentHandleLike>()
  private readonly ensuring = new Map<string, Promise<{ agent: AgentLike; sessionId: SessionIdType; created: boolean }>>()

  constructor(
    private readonly agents: AgentsServiceLike,
    private readonly opts: AgentManagerOptions,
  ) {}

  async ensure(
    channel: ChannelKind,
    userId: string,
    presetId?: string,
    options: EnsureAgentOptions = {},
  ): Promise<{ agent: AgentLike; sessionId: SessionIdType; created: boolean }> {
    const key = bindingKeyFor(channel, userId, this.opts.sharedSession)
    // Serialize per conversation key.  Adapters deliver inbound messages without
    // awaiting the previous handler, so two messages arriving back to back on
    // first contact both saw no binding and both called `agents.create` with the
    // same deterministic SessionId; the loser threw "session ... already exists"
    // and the user got ⚠️ 处理失败 instead of an answer.
    const inFlight = this.ensuring.get(key)
    if (inFlight !== undefined) return await inFlight
    const run = this.ensureOnce(key, channel, userId, presetId, options)
      .finally(() => { this.ensuring.delete(key) })
    this.ensuring.set(key, run)
    return await run
  }

  private async ensureOnce(
    key: string,
    channel: ChannelKind,
    userId: string,
    presetId?: string,
    options: EnsureAgentOptions = {},
  ): Promise<{ agent: AgentLike; sessionId: SessionIdType; created: boolean }> {
    const known = this.opts.getBinding(key)
    if (known !== undefined) {
      const live = this.agents.get(SessionId(known))
      if (live !== undefined) return { agent: live, sessionId: live.id, created: false }
      try {
        const handle = await this.agents.resume({
          resumeSessionId: SessionId(known),
          agentOptions: this.modelOptions(known),
          setup: this.setup(presetId, false),
        })
        this.handles.set(String(handle.agent.id), handle)
        return { agent: handle.agent, sessionId: handle.agent.id, created: false }
      } catch (error) {
        this.opts.logger.warn(`[qq-weixin] resume ${known} failed, will create: ${String(error)}`)
      }
    }
    const sessionId = SessionId(`qq-weixin-${key.replace(/[^a-zA-Z0-9-]/g, '-')}`)
    return this.createAndBind(key, sessionId, presetId, options.cwd)
  }

  /** Start a distinct durable session and make it active for this channel owner. */
  async createFresh(
    channel: ChannelKind,
    userId: string,
    presetId?: string,
    cwd?: string,
    model?: { provider: string; model: string },
  ): Promise<{ agent: AgentLike; sessionId: SessionIdType; created: true }> {
    const key = bindingKeyFor(channel, userId, this.opts.sharedSession)
    const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const sessionId = SessionId(`qq-weixin-${key.replace(/[^a-zA-Z0-9-]/g, '-')}-${suffix}`)
    return this.createAndBind(key, sessionId, presetId, cwd, model)
  }

  /** Rebuild the active Agent with a new model while retaining completed context. */
  async forkWithModel(
    channel: ChannelKind,
    userId: string,
    source: AgentLike,
    model: { provider: string; model: string },
    presetId?: string,
    cwd?: string,
  ): Promise<{ agent: AgentLike; sessionId: SessionIdType; created: true }> {
    if (source.status === 'running') {
      source.cancel({ kind: 'user' })
      await source.whenIdle()
    }
    const key = bindingKeyFor(channel, userId, this.opts.sharedSession)
    const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const sessionId = SessionId(`qq-weixin-${key.replace(/[^a-zA-Z0-9-]/g, '-')}-model-${suffix}`)
    const seed = [...source.session.snapshotEvents()]
    const handle = await this.agents.create({
      sessionId,
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: {
        ...(cwd !== undefined && cwd !== ''
          ? { cwd }
          : this.opts.cwd !== undefined && this.opts.cwd !== '' ? { cwd: this.opts.cwd } : {}),
        parentSession: source.id,
        isSeeded: true,
        ...(presetId !== undefined ? { agentPreset: presetId } : {}),
      },
      agentOptions: model,
      setup: this.setup(presetId),
    })
    this.handles.set(String(handle.agent.id), handle)
    await this.opts.persistBinding(key, sessionId)
    return { agent: handle.agent, sessionId, created: true }
  }

  /** Select a known durable session; it is resumed lazily by ensure(). */
  async select(channel: ChannelKind, userId: string, sessionId: string): Promise<void> {
    const key = bindingKeyFor(channel, userId, this.opts.sharedSession)
    await this.opts.persistBinding(key, SessionId(sessionId))
  }

  /** Dispose only an Agent whose capability handle is owned by this manager. */
  async disposeOwned(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId)
    if (handle === undefined) return
    this.handles.delete(sessionId)
    await handle.dispose()
  }

  private async createAndBind(
    key: string,
    sessionId: SessionIdType,
    presetId?: string,
    cwd?: string,
    model?: { provider: string; model: string },
  ): Promise<{ agent: AgentLike; sessionId: SessionIdType; created: true }> {
    const handle = await this.agents.create({
      sessionId,
      meta: {
        ...(cwd !== undefined && cwd !== ''
          ? { cwd }
          : this.opts.cwd !== undefined && this.opts.cwd !== '' ? { cwd: this.opts.cwd } : {}),
        ...(presetId !== undefined ? { agentPreset: presetId } : {}),
      },
      agentOptions: model ?? this.modelOptions(String(sessionId)),
      setup: this.setup(presetId),
    })
    this.handles.set(String(handle.agent.id), handle)
    await this.opts.persistBinding(key, sessionId)
    return { agent: handle.agent, sessionId, created: true }
  }

  private modelOptions(sessionId?: string): { provider?: string; model?: string } {
    const override = sessionId === undefined ? undefined : this.opts.getModelSelection?.(sessionId)
    if (override !== undefined) return override
    const selection = this.opts.defaultModel?.currentSelection()
    return selection !== undefined ? { provider: selection.provider, model: selection.model } : {}
  }

  private setup(presetId?: string, initializeApproval = true): NonNullable<CreateAgentOptionsLike['setup']> {
    return async (agentCtx: import('@deepseek-ai/cordis').Context, agent: AgentLike): Promise<AgentSetupCommitLike | void> => {
      if (agent !== undefined && initializeApproval) {
        // 真实 Session 类型通过官方运行时函数签名取得，避免编造类型。
        const session = agent.session as unknown as Parameters<typeof setApprovalPolicy>[0]
        setApprovalPolicy(session, this.opts.approvalPolicy)
      }
      if (presetId !== undefined && this.opts.presets !== undefined) {
        await this.opts.presets.mount(agentCtx, presetId)
      }
      return {
        commit: () => {
          this.opts.logger.info(`[qq-weixin] agent ${agent?.id ?? '(unknown)'} committed at publish`)
        },
      }
    }
  }
}
