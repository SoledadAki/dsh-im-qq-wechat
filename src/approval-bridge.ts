/**
 * 审批与 elicitation 的外部通道桥（Q5）。
 *
 * 两条官方接缝，官方 Web 端完整实现见 dsh-host-apiproxy/lib/index.js
 * （:1913-1943 的 userQuestions provider、:1955-2007 的 approval answerer），
 * 本文件把"浏览器 mux + 点选"换成"QQ/微信消息 + 回复"，Host 侧结构原样照抄：
 *
 * 1) 审批：ctx.approval.request() 派发带 agent 作用域的 waterfall 事件
 *    'approval/request'，answerer 返回 ApprovalOutcome（allowed-once /
 *    rejected / cancelled / unavailable）。决定权就是返回值——无需额外
 *    approve API。审计事件 approval/asked + approval/decided 自动落日志。
 *    注意：session approval policy 为 'never' 时，ApprovalService 在分发
 *    answerer 之前直接返回 'rejected'（dsh-user-approval 判 policy 先于
 *    waterfall），所以桥接器要求 policy === 'ask'（见 agent-bridge 的
 *    setApprovalPolicy 与 cordis.patch.yml 的 approvalPolicy 配置）。
 *
 * 2) elicitation：ctx.userQuestions.ask() 把问题交给唯一注册的 provider，
 *    provider 返回答案数组后作为 tool result 回到 agent 循环。
 */

import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, BridgeQuestion, ChannelAdapter, ChannelKind } from './channel.js'
import type { AgentLike } from './agent-bridge.js'

export interface ApprovalRequestLike {
  readonly agent: AgentLike
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export interface OwnerInfo {
  readonly channel: ChannelKind
  readonly userId: string
}

interface AnswererDeps {
  readonly adapters: ReadonlyMap<ChannelKind, ChannelAdapter>
  readonly ownerBySession: ReadonlyMap<string, OwnerInfo>
  readonly routeForRequest?: (sessionId: string, callId?: string) => OwnerInfo | undefined
  readonly logger: { warn(msg: string, ...rest: unknown[]): void }
}

/**
 * 注册 approval/request answerer：把审批请求发到该 Agent 所属外部通道，
 * 用户决定经返回值送回。不认识的 agent 或未绑定通道时调用 next() 放行。
 */
export function installApprovalAnswerer(
  ctx: { on(name: string, listener: (...args: any[]) => unknown): () => void },
  deps: AnswererDeps,
): () => void {
  return ctx.on('approval/request', (req: ApprovalRequestLike, next: () => Promise<string>) => {
    const owner = deps.routeForRequest
      ? deps.routeForRequest(req.agent.id, req.callId)
      : deps.ownerBySession.get(req.agent.id)
    const adapter = owner === undefined ? undefined : deps.adapters.get(owner.channel)
    // There is no safe external recipient to answer for an unknown agent.
    // Do not delegate to another answerer, which could approve it blindly.
    if (owner === undefined || adapter === undefined) return Promise.resolve('unavailable' as ApprovalOutcome)
    if (req.signal?.aborted === true) return Promise.resolve('cancelled' as ApprovalOutcome)
    return adapter.askApproval(owner.userId, {
      toolName: req.toolName,
      ...(req.callId !== undefined ? { callId: req.callId } : {}),
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
    }, req.signal)
  })
}

interface QuestionRequestLike {
  readonly agent?: AgentLike
  readonly questions: ReadonlyArray<BridgeQuestion>
  readonly signal?: AbortSignal
}

/**
 * 注册 userQuestions provider：把 ask() 的问题发到外部通道，逐题回答
 * 返回给 agent 循环。只允许一个 provider 存活（重复注册抛
 * UserQuestionError DUPLICATE_PROVIDER）。
 */
export function installQuestionProvider(
  ctx: { userQuestions: { registerProvider(provider: unknown): () => void } },
  deps: AnswererDeps,
): () => void {
  return ctx.userQuestions.registerProvider({
    ask(request: QuestionRequestLike): Promise<AskUserQuestionAnswer> {
      if (request.agent === undefined) {
        return Promise.reject(new UserQuestionError('qq-weixin: 问题缺少调用 agent', 'CALLER_NOT_LIVE'))
      }
      const owner = deps.routeForRequest
        ? deps.routeForRequest(request.agent.id)
        : deps.ownerBySession.get(request.agent.id)
      const adapter = owner === undefined ? undefined : deps.adapters.get(owner.channel)
      if (owner === undefined || adapter === undefined) {
        return Promise.reject(
          new UserQuestionError('qq-weixin: 该 agent 未绑定任何外部通道', 'CALLER_NOT_LIVE'),
        )
      }
      return adapter.askQuestion(owner.userId, request.questions, request.signal).then((answers) => ({
        answers: request.questions.map((question, index) => {
          const raw = answers[index] ?? ''
          const labels = new Set(question.options?.map((option) => option.label) ?? [])
          const selected = raw.split(/[,，]/).map((item) => item.trim()).filter((item) => labels.has(item))
          return {
            id: question.id,
            selected,
            ...(selected.length === 0 && raw !== '' ? { custom: raw } : {}),
          }
        }),
      }))
    },
  })
}
