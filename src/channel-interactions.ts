import { randomUUID } from 'node:crypto'
import type { ApprovalOutcome, ApprovalPrompt, BridgeQuestion } from './channel.js'

type Pending =
  | { kind: 'approval'; resolve(value: ApprovalOutcome): void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void }
  | { kind: 'question'; count: number; resolve(value: string[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void }

export class ChannelInteractions {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly send: (text: string) => Promise<void>,
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  async askApproval(prompt: ApprovalPrompt, signal?: AbortSignal): Promise<ApprovalOutcome> {
    if (signal?.aborted) return 'cancelled'
    const id = this.id()
    const answer = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => { this.remove(id); resolve('unavailable') }, this.timeoutMs)
      const abort = () => this.finishApproval(id, 'cancelled')
      this.pending.set(id, { kind: 'approval', resolve, timer, signal, abort })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    void answer.catch(() => undefined)
    try {
      void this.send(`需要安全审核 #${id}\n操作：${prompt.toolName}${prompt.reason ? `\n原因：${prompt.reason}` : ''}\n回复 /同意 ${id} 或 /拒绝 ${id}`).catch(() => this.finishApproval(id, 'unavailable'))
    } catch { this.finishApproval(id, 'unavailable') }
    return answer
  }

  async askQuestion(questions: ReadonlyArray<BridgeQuestion>, signal?: AbortSignal): Promise<string[]> {
    if (signal?.aborted) throw new Error('用户问题已取消')
    if (questions.length === 0) return []
    const id = this.id()
    const answer = new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => { this.remove(id); reject(new Error('用户问题已超时')) }, this.timeoutMs)
      const abort = () => this.rejectQuestion(id, new Error('用户问题已取消'))
      this.pending.set(id, { kind: 'question', count: questions.length, resolve, reject, timer, signal, abort })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    void answer.catch(() => undefined)
    const rendered = questions.map((q, i) => `${i + 1}. ${q.question}${q.detail ? `\n${q.detail}` : ''}${q.options?.length ? ` [${q.options.map((o) => o.label).join(' / ')}]` : ''}`).join('\n')
    try { void this.send(`问题 #${id}\n${rendered}\n回复 /answer ${id} 答案1 | 答案2`).catch((error) => this.rejectQuestion(id, error instanceof Error ? error : new Error(String(error)))) }
    catch (error) { this.rejectQuestion(id, error instanceof Error ? error : new Error(String(error))) }
    return answer
  }

  accept(text: string): boolean {
    const approval = /^\/(approve|reject|同意|拒绝)\s+([a-f0-9]{8})$/i.exec(text.trim())
    if (approval) {
      const value = approval[1]!.toLowerCase()
      const id = approval[2]!.toLowerCase()
      // Consume only a decision that addressed a live approval.  An unknown or
      // stale id used to be swallowed silently, so the command vanished with no
      // reply and never reached the agent either.
      if (this.pending.get(id)?.kind !== 'approval') return false
      this.finishApproval(id, value === 'approve' || value === '同意' ? 'allowed-once' : 'rejected')
      return true
    }
    const answer = /^\/answer\s+([a-f0-9]{8})\s+([\s\S]+)$/i.exec(text.trim())
    if (!answer) return false
    const pending = this.pending.get(answer[1]!.toLowerCase())
    // Same reasoning: `/answer` for an id that is not a live question is not a
    // decision, so let the text through instead of dropping it.
    if (pending?.kind !== 'question') return false
    const values = answer[2]!.split('|').map((item) => item.trim())
    if (values.length !== pending.count || values.some((item) => !item)) return true
    this.remove(answer[1]!.toLowerCase())
    pending.resolve(values)
    return true
  }

  cancel(): void {
    for (const [id, item] of [...this.pending]) {
      if (item.kind === 'approval') this.finishApproval(id, 'cancelled')
      else this.rejectQuestion(id, new Error('通道已关闭'))
    }
  }

  private finishApproval(id: string, outcome: ApprovalOutcome): void {
    const item = this.pending.get(id)
    if (item?.kind !== 'approval') return
    this.remove(id)
    item.resolve(outcome)
  }

  private rejectQuestion(id: string, error: Error): void {
    const item = this.pending.get(id)
    if (item?.kind !== 'question') return
    this.remove(id)
    item.reject(error)
  }

  private remove(id: string): void {
    const item = this.pending.get(id)
    if (!item) return
    clearTimeout(item.timer)
    if (item.signal && item.abort) item.signal.removeEventListener('abort', item.abort)
    this.pending.delete(id)
  }

  private id(): string { return randomUUID().replaceAll('-', '').slice(0, 8) }
}
