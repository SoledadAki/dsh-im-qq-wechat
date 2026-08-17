/**
 * Agent 生命周期桥：稳定 SessionId 创建/恢复 Agent、挂载 preset、指定 cwd、
 * 实现 AgentSetupCommit，并用官方工厂构造带 MessageId 的 UserMessage。
 *
 * 类型说明：Agent/AgentHandle 等对象来自 ctx.agents / ctx.agents.create()
 * 的返回值，本文件用结构类型（本地接口）描述，不导入未验证的类型名；
 * 运行时 import 全部是 rc.6 真实公开 export（见文件底部注释）。
 */

import { randomBytes } from 'node:crypto'

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ChannelKind } from './channel.js'
import { bindingKeyFor } from './channel.js'
import type { SessionEventLike } from './correlation.js'

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
export interface SessionLike {
  readonly id: SessionIdType
  readonly events: ReadonlyArray<SessionEventLike>
  append(type: string, data: unknown): unknown
}

export interface AgentLike {
  readonly id: SessionIdType
  readonly session: SessionLike
  readonly status: 'idle' | 'running'
  readonly options?: { readonly provider?: string; readonly model?: string }
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
  cancel(cause: { readonly kind: 'user' }): void
  whenIdle(): Promise<void>
}

export interface AgentSetupCommitLike {
  commit(): void
}

export interface AgentHandleLike {
  readonly agent: AgentLike
  dispose(): Promise<void> | void
}

export interface CreateAgentOptionsLike {
  readonly sessionId: SessionIdType
  readonly seed?: ReadonlyArray<SessionEventLike>
  readonly meta?: {
    readonly cwd?: string
    readonly agentPreset?: string
    readonly parentSession?: SessionIdType
    readonly seedLength?: number
  }
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
  readonly signal?: AbortSignal
  readonly setup?: (
    agentCtx: unknown,
  ) => Promise<AgentSetupCommitLike | void> | AgentSetupCommitLike | void
}

export interface ResumeAgentOptionsLike {
  readonly resumeSessionId: SessionIdType
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
  readonly signal?: AbortSignal
  readonly setup?: CreateAgentOptionsLike['setup']
}

export interface AgentsServiceLike {
  create(options: CreateAgentOptionsLike): Promise<AgentHandleLike>
  resume(options: ResumeAgentOptionsLike): Promise<AgentHandleLike>
  get(id: SessionIdType): AgentLike | undefined
}

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
    const seed = [...source.session.events]
    const handle = await this.agents.create({
      sessionId,
      seed,
      meta: {
        ...(cwd !== undefined && cwd !== ''
          ? { cwd }
          : this.opts.cwd !== undefined && this.opts.cwd !== '' ? { cwd: this.opts.cwd } : {}),
        parentSession: source.id,
        seedLength: seed.length,
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
    return async (agentCtx: unknown): Promise<AgentSetupCommitLike | void> => {
      const agent = (agentCtx as { agent?: AgentLike }).agent
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

/*
 * 运行时 import 一览（全部为 rc.6 真实公开 export，源码路径见答案末尾）：
 *   createUserMessage, MessageId — @deepseek-ai/dsh-llm（message.js）
 *   SessionId                      — @deepseek-ai/dsh-session（types.js）
 *   setApprovalPolicy              — @deepseek-ai/dsh-user-approval（types/index.js）
 * 类型 import（npm 包随包发布 lib/types/**\/*.d.ts）：
 *   MessageSource, UserMessage     — @deepseek-ai/dsh-llm
 *   SessionIdType                  — @deepseek-ai/dsh-session
 * 未导入：Agent/AgentHandle 等类型使用本地结构接口（未验证的导出名不编造）。
 */
