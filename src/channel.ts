/**
 * Channel adapter contract: the seam between an external platform (QQ, WeChat)
 * and the Harness. First phase is text-only; image transport is represented by
 * the interface shape below but is not sent to the current DeepSeek
 * chat adapter rejects image content with UNSUPPORTED_CONTENT).
 *
 * The production adapters use isolated QQ Gateway and Weixin iLink sidecars.
 */

export type ChannelKind = 'qq' | 'wechat' | 'wecom' | 'feishu' | 'telegram'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface InboundTextMessage {
  readonly channel: ChannelKind
  readonly userId: string
  readonly extId: string
  readonly text: string
  readonly timestamp: number
}

/** 图片入站接口（第一阶段保留、不启用）：媒体类型与字节/URL。 */
export interface InboundImageMessage {
  readonly channel: ChannelKind
  readonly userId: string
  readonly extId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly data: Uint8Array
  readonly name?: string
}

export interface ApprovalPrompt {
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
}

export interface BridgeQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  readonly multiSelect?: boolean
}

export type BindingState = 'idle' | 'awaiting-code' | 'bound'

export interface ChannelStatus {
  readonly state: BindingState
  readonly connected: boolean
  readonly boundUserId?: string
  readonly qrDataUrl?: string
  readonly code?: string
  readonly error?: string
}

export interface ChannelReplyStream {
  update(text: string): void | Promise<void>
  finish(text: string): Promise<void>
  cancel(): void | Promise<void>
}

/**
 * One external platform's transport. Every method that waits on a human
 * (askApproval / askQuestion) resolves when the external user answers.
 */
export interface ChannelAdapter {
  readonly kind: ChannelKind
  start(): Promise<void>
  stop(): Promise<void>
  dispose(): Promise<void>

  /** 回发最终结果（correlation 在 turn/end 时调用）。 */
  sendText(userId: string, text: string, replyToId?: string): Promise<void>
  /** Native typing indicator when the platform exposes one. */
  sendTyping?(userId: string, replyToId?: string): Promise<void>
  /** Native/editable streaming reply. Undefined means final-message fallback. */
  openReplyStream?(userId: string, replyToId: string): Promise<ChannelReplyStream | undefined>
  /** Credential-based channels (Feishu/Telegram) use this instead of QR login. */
  configure?(values: Readonly<Record<string, string>>): Promise<void>

  /** 把审批请求发到外部平台，返回用户决定。 */
  askApproval(userId: string, prompt: ApprovalPrompt, signal?: AbortSignal): Promise<ApprovalOutcome>
  /** 把 elicitation 问题发到外部平台，返回逐题答案（与 questions 同序）。 */
  askQuestion(userId: string, questions: ReadonlyArray<BridgeQuestion>, signal?: AbortSignal): Promise<string[]>

  /** 绑定流程：开始 → 二维码 → 提交验证码 → 绑定成功。 */
  startBinding(): Promise<{ qrDataUrl: string; code?: string }>
  submitCode(userId: string, code: string): Promise<{ ok: boolean; error?: string }>
  cancelBinding(): Promise<void>
  unbind(): Promise<void>

  getStatus(): ChannelStatus
  onInbound(callback: (message: InboundTextMessage) => void): () => void
}

/** 会话映射键：sharedSession 时所有通道共享一个 owner Session。 */
export function bindingKeyFor(channel: ChannelKind, userId: string, sharedSession: boolean): string {
  return sharedSession ? 'shared' : `${channel}:${userId}`
}
