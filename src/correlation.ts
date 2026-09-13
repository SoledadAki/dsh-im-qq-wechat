/**
 * 外部消息 ↔ Agent turn 的精确关联（Q3 方案）。
 *
 * followup() 返回 void，但关联三件套都是公开 API：
 *   1. MessageId —— buildInboundMessage() 构造时就已知（createUserMessage 内部生成）；
 *   2. agent/inbox/claimed —— 把 MessageId 绑定到 turn 号；
 *   3. session/event 的 turn/end —— 用 (sessionId, turn) 过滤会话日志，
 *      通过 extractTurnText() 取该 turn 的最终 assistant/message 文本。
 */

import type { ChannelKind, ChannelReplyStream } from './channel.js'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'

/** 最小的会话事件视图（供纯函数与测试使用，不依赖真实 Session 类型）。 */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: {
    readonly turn?: number
    readonly step?: number
    readonly message?: { readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> }
    readonly chunk?: { readonly type?: string; readonly text?: string; readonly index?: number }
    readonly config?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
    readonly reason?: unknown
  }
}

export interface TrackedInbound {
  readonly extId: string
  readonly sessionId: string
  readonly channel: ChannelKind
  readonly userId: string
  readonly msgId: string
  /** 由 agent/inbox/claimed 绑定。 */
  turn?: number
  replyText: string
  replySeq?: number
  reason?: unknown
  done: boolean
  /** 超时 disposer（由 ctx.timeout 返回），turn/end 时取消。 */
  timeout?: () => void
  stream?: ChannelReplyStream
  streamText: string
}

/**
 * 纯函数：从会话日志中提取某个 turn 的最终用户可见文本。
 * 规则与 dsh-headless 的 summarize() 一致：turn/start 之后、turn/end 之前，
 * 取最后一个非空 assistant/message 的 text 块拼接结果。
 */
export function extractTurnText(events: ReadonlyArray<SessionEventLike>, turn: number): {
  text: string
  replySeq?: number
  reason?: unknown
} {
  let text = ''
  let replySeq: number | undefined
  let reason: unknown
  for (const event of events) {
    if (event.type === 'turn/end' && event.data?.turn === turn) {
      reason = event.data.reason
      break
    }
    if (event.type === 'assistant/message' && event.data?.turn === turn) {
      const joined = (event.data.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text?: string }).text ?? '')
        .join('')
      if (joined !== '') {
        text = joined
        replySeq = event.seq
      }
    }
  }
  return { text, replySeq, reason }
}

/** 把 turn/end 的 reason 渲染成回发外部平台的文本。 */
export function describeTurnReason(reason: unknown): string {
  if (reason === undefined) return '（无输出）'
  const r = reason as { kind?: string; error?: { code?: string; message?: string } }
  switch (r.kind) {
    case 'completed':
      return '（完成）'
    case 'blocked':
      return '（任务被阻塞，未产生回复）'
    case 'max-tokens':
      return '（达到 token 上限，输出被截断）'
    case 'aborted':
      return '（任务已取消）'
    case 'interrupted':
      return '（任务被中断）'
    case 'error':
      return `⚠️ 出错：${r.error?.message ?? r.error?.code ?? '未知错误'}`
    default:
      return `（回合结束：${r.kind ?? 'unknown'}）`
  }
}

/**
 * 入站消息追踪器：MessageId → turn → 最终文本 → turn/end 回执。
 * 同一 turn 内的多条入站消息共享该 turn 的最终文本（batch 语义）。
 */
export class InboundTracker {
  private readonly byExtId = new Map<string, TrackedInbound>()
  private readonly callTurns = new Map<string, number>()
  private readonly attempts = new Map<string, { id: string; revision: number; turn: number; index: number }>()

  onAssistantStream(sessionId: string, frame: AssistantStreamFrame): TrackedInbound[] {
    if (frame.type === 'start') {
      if (!this.activeForTurn(sessionId, frame.turn).length) return []
      this.attempts.set(sessionId, { id: frame.attemptId, revision: frame.revision, turn: frame.turn, index: -1 })
      this.setAssistantText(sessionId, frame.turn, '')
      return []
    }
    const attempt = this.attempts.get(sessionId)
    if (!attempt || attempt.id !== frame.attemptId || attempt.revision !== frame.revision) return []
    if (frame.type === 'end') { this.attempts.delete(sessionId); return [] }
    if (frame.index <= attempt.index) return []
    attempt.index = frame.index
    return frame.chunk.type === 'text-delta'
      ? this.appendTextDelta(sessionId, attempt.turn, frame.chunk.text)
      : []
  }

  register(input: {
    extId: string
    sessionId: string
    channel: ChannelKind
    userId: string
    msgId: string
  }): TrackedInbound {
    const tracked: TrackedInbound = { ...input, replyText: '', streamText: '', done: false }
    this.byExtId.set(input.extId, tracked)
    return tracked
  }

  remove(extId: string): void {
    this.byExtId.delete(extId)
  }

  /** agent/inbox/claimed：MessageId ↔ turn 绑定。 */
  onInboxClaimed(msgId: string, turn: number): void {
    for (const tracked of this.byExtId.values()) {
      if (tracked.msgId === msgId && tracked.turn === undefined) tracked.turn = turn
    }
  }

  routeForTurn(sessionId: string, turn: number | undefined): Pick<TrackedInbound, 'channel' | 'userId'> | undefined {
    if (turn === undefined) {
      const candidates = [...this.byExtId.values()].filter((item) => item.sessionId === sessionId && !item.done && item.turn !== undefined)
      const first = candidates[0]
      if (first === undefined) return undefined
      return candidates.every((item) => item.channel === first.channel && item.userId === first.userId)
        ? { channel: first.channel, userId: first.userId }
        : undefined
    }
    for (const tracked of this.byExtId.values()) {
      if (tracked.sessionId === sessionId && tracked.turn === turn && !tracked.done) {
        return { channel: tracked.channel, userId: tracked.userId }
      }
    }
    return undefined
  }

  activeForTurn(sessionId: string, turn: number): TrackedInbound[] {
    return [...this.byExtId.values()].filter((item) => item.sessionId === sessionId && item.turn === turn && !item.done)
  }

  appendTextDelta(sessionId: string, turn: number, text: string): TrackedInbound[] {
    const items = this.activeForTurn(sessionId, turn)
    for (const item of items) item.streamText += text
    return items
  }

  setAssistantText(sessionId: string, turn: number, text: string): TrackedInbound[] {
    const items = this.activeForTurn(sessionId, turn)
    for (const item of items) item.streamText = text
    return items
  }

  onToolCall(sessionId: string, callId: string, turn: number): void {
    this.callTurns.set(`${sessionId}:${callId}`, turn)
  }

  routeForCall(sessionId: string, callId: string | undefined): Pick<TrackedInbound, 'channel' | 'userId'> | undefined {
    if (callId === undefined) return this.routeForTurn(sessionId, undefined)
    return this.routeForTurn(sessionId, this.callTurns.get(`${sessionId}:${callId}`))
  }

  /**
   * session/event 收到 turn/end 时调用：以 (sessionId, turn) 过滤并结算，
   * 返回所有被结算的入站消息（调用方负责取消超时并回发）。
   */
  onTurnEnd(sessionId: string, turn: number, events: ReadonlyArray<SessionEventLike>): TrackedInbound[] {
    const { text, replySeq, reason } = extractTurnText(events, turn)
    const finalized: TrackedInbound[] = []
    for (const tracked of [...this.byExtId.values()]) {
      // An unclaimed inbound item must never be settled by another turn in a
      // shared session.  Only agent/inbox/claimed establishes this link.
      if (tracked.sessionId !== sessionId || tracked.done || tracked.turn !== turn) continue
      tracked.done = true
      tracked.replyText = text
      tracked.replySeq = replySeq
      tracked.reason = reason
      this.byExtId.delete(tracked.extId)
      finalized.push(tracked)
    }
    this.clearCallTurns(sessionId, turn)
    return finalized
  }

  /** Agent 被 dispose（agent/disposed）时清理其未决消息。 */
  dropSession(sessionId: string): void {
    this.attempts.delete(sessionId)
    for (const [extId, tracked] of this.byExtId) {
      if (tracked.sessionId === sessionId) { void tracked.stream?.cancel(); this.byExtId.delete(extId) }
    }
    for (const key of this.callTurns.keys()) if (key.startsWith(`${sessionId}:`)) this.callTurns.delete(key)
  }

  /** Finalize only messages claimed for this failed turn. */
  failTurn(sessionId: string, turn: number, reason: unknown): TrackedInbound[] {
    const failed: TrackedInbound[] = []
    for (const tracked of [...this.byExtId.values()]) {
      if (tracked.sessionId !== sessionId || tracked.done || tracked.turn !== turn) continue
      tracked.done = true
      tracked.reason = reason
      this.byExtId.delete(tracked.extId)
      failed.push(tracked)
    }
    this.clearCallTurns(sessionId, turn)
    return failed
  }

  clear(): void {
    for (const tracked of this.byExtId.values()) void tracked.stream?.cancel()
    this.byExtId.clear()
    this.callTurns.clear()
    this.attempts.clear()
  }

  private clearCallTurns(sessionId: string, turn: number): void {
    if (this.attempts.get(sessionId)?.turn === turn) this.attempts.delete(sessionId)
    for (const [key, mappedTurn] of this.callTurns) {
      if (mappedTurn === turn && key.startsWith(`${sessionId}:`)) this.callTurns.delete(key)
    }
  }
}
