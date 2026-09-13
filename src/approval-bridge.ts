/** Agent-scoped approval and question waterfalls for Harness 0.1.5-rc.2. */

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
  readonly ownsSession?: (sessionId: string) => boolean
  readonly logger: { warn(msg: string, ...rest: unknown[]): void }
}

/**
 * 注册 approval/request answerer：把审批请求发到该 Agent 所属外部通道，
 * 用户决定经返回值送回。不认识的 agent 或未绑定通道时调用 next() 放行。
 */
export function installApprovalAnswerer(
  ctx: { on(name: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void },
  deps: AnswererDeps,
): () => void {
  return ctx.on('approval/request', (req: ApprovalRequestLike, next: () => Promise<string>) => {
    // Leave ordinary Harness sessions to the Host's own answerer.
    if (deps.ownsSession && !deps.ownsSession(req.agent.id)) return next()
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
  }, { prepend: true })
}

interface QuestionRequestLike {
  readonly agent?: AgentLike
  readonly questions: ReadonlyArray<BridgeQuestion>
  readonly signal?: AbortSignal
}

/** IM sessions answer locally; other sessions continue to the Host UI. */
export function installQuestionProvider(
  ctx: { on(name: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void },
  deps: AnswererDeps,
): () => void {
  return ctx.on('user-questions/request', async (request: QuestionRequestLike, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> => {
    if (!request.agent || (deps.ownsSession && !deps.ownsSession(request.agent.id))) return next()
    const owner = deps.routeForRequest
      ? deps.routeForRequest(request.agent.id)
      : deps.ownerBySession.get(request.agent.id)
    const adapter = owner === undefined ? undefined : deps.adapters.get(owner.channel)
    if (!owner || !adapter) throw new UserQuestionError('IM 会话没有可用的接收通道', 'NO_PROVIDER')
    if (request.signal?.aborted) throw new UserQuestionError('用户问题已取消', 'ASK_ABORTED')
    const answers = await adapter.askQuestion(owner.userId, request.questions, request.signal)
    return {
      answers: request.questions.map((question, index) => {
        const raw = answers[index] ?? ''
        const labels = new Set(question.options?.map((option) => option.label) ?? [])
        const selected = raw.split(/[,，]/).map((item) => item.trim()).filter((item) => labels.has(item))
        return { id: question.id, selected, ...(selected.length === 0 && raw !== '' ? { custom: raw } : {}) }
      }),
    }
  }, { prepend: true })
}
