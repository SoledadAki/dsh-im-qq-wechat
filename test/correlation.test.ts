import { test } from 'node:test'
import assert from 'node:assert/strict'

import { InboundTracker, describeTurnReason, extractTurnText } from '../src/correlation.js'
import type { SessionEventLike } from '../src/correlation.js'
import { buildInboundMessage } from '../src/agent-bridge.js'

function turnEvents(turn: number, assistantText: string, reason: unknown = { kind: 'completed' }): SessionEventLike[] {
  return [
    { type: 'turn/start', seq: 0, data: { turn } },
    { type: 'user/message', seq: 1, data: { turn } },
    { type: 'assistant/message', seq: 2, data: { turn, message: { content: [{ type: 'text', text: assistantText }] } } },
    { type: 'turn/end', seq: 3, data: { turn, reason } },
  ]
}

test('extractTurnText 取该 turn 最终 assistant/message 的文本与 seq', () => {
  const { text, reason, replySeq } = extractTurnText(turnEvents(1, '你好，世界'), 1)
  assert.equal(text, '你好，世界')
  assert.equal(replySeq, 2)
  assert.deepEqual(reason, { kind: 'completed' })
})

test('extractTurnText 忽略其它 turn 的事件', () => {
  const events = [...turnEvents(1, '第一轮'), ...turnEvents(2, '第二轮')]
  const { text } = extractTurnText(events, 2)
  assert.equal(text, '第二轮')
})

test('extractTurnText 在 error turn 保留最后的输出', () => {
  const events = turnEvents(1, '部分输出', { kind: 'error', error: { code: 'X', message: 'boom' } })
  const { text, reason } = extractTurnText(events, 1)
  assert.equal(text, '部分输出')
  assert.equal((reason as { kind: string }).kind, 'error')
})

test('describeTurnReason 渲染 error reason', () => {
  assert.equal(describeTurnReason({ kind: 'error', error: { code: 'X', message: 'boom' } }), '⚠️ 出错：boom')
  assert.equal(describeTurnReason({ kind: 'completed' }), '（完成）')
})

test('InboundTracker：claimed 绑定 turn，turn/end 结算并返回回执', () => {
  const tracker = new InboundTracker()
  tracker.register({ extId: 'qq-1', sessionId: 's1', channel: 'qq', userId: 'u1', msgId: 'm1' })
  tracker.onInboxClaimed('m1', 3)
  const finalized = tracker.onTurnEnd('s1', 3, turnEvents(3, '回执文本'))
  assert.equal(finalized.length, 1)
  assert.equal(finalized[0]?.turn, 3)
  assert.equal(finalized[0]?.replyText, '回执文本')
  assert.equal(finalized[0]?.replySeq, 2)
  // 已结算的消息不会二次结算
  assert.equal(tracker.onTurnEnd('s1', 3, turnEvents(3, 'again')).length, 0)
})

test('InboundTracker：未 claimed 的消息不能被同一 session 的 turn/end 误结算', () => {
  const tracker = new InboundTracker()
  tracker.register({ extId: 'wx-1', sessionId: 'shared', channel: 'wechat', userId: 'u2', msgId: 'm2' })
  assert.equal(tracker.onTurnEnd('shared', 8, turnEvents(8, 'unrelated')).length, 0)
})

test('InboundTracker：agent error 只结算已 claimed 的对应 turn', () => {
  const tracker = new InboundTracker()
  tracker.register({ extId: 'qq-1', sessionId: 'shared', channel: 'qq', userId: 'u1', msgId: 'm1' })
  tracker.register({ extId: 'wx-1', sessionId: 'shared', channel: 'wechat', userId: 'u2', msgId: 'm2' })
  tracker.onInboxClaimed('m1', 4)
  const failed = tracker.failTurn('shared', 4, { kind: 'error' })
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.extId, 'qq-1')
  assert.equal(tracker.onTurnEnd('shared', 5, turnEvents(5, 'not wx yet')).length, 0)
})

test('InboundTracker：审批 callId 精确路由到触发它的 turn', () => {
  const tracker = new InboundTracker()
  tracker.register({ extId: 'qq-1', sessionId: 'shared', channel: 'qq', userId: 'owner-q', msgId: 'm1' })
  tracker.register({ extId: 'wx-1', sessionId: 'shared', channel: 'wechat', userId: 'owner-w', msgId: 'm2' })
  tracker.onInboxClaimed('m1', 11)
  tracker.onInboxClaimed('m2', 12)
  tracker.onToolCall('shared', 'call-q', 11)
  tracker.onToolCall('shared', 'call-w', 12)
  assert.deepEqual(tracker.routeForCall('shared', 'call-q'), { channel: 'qq', userId: 'owner-q' })
  assert.deepEqual(tracker.routeForCall('shared', 'call-w'), { channel: 'wechat', userId: 'owner-w' })
  assert.equal(tracker.routeForTurn('shared', undefined), undefined, 'ambiguous question route must fail closed')
})

test('InboundTracker：dropSession 清理未决消息', () => {
  const tracker = new InboundTracker()
  tracker.register({ extId: 'qq-2', sessionId: 's1', channel: 'qq', userId: 'u1', msgId: 'm2' })
  tracker.dropSession('s1')
  assert.equal(tracker.onTurnEnd('s1', 1, turnEvents(1, 'x')).length, 0)
})

test('buildInboundMessage 用官方工厂生成 MessageId 并携带扩展 source kind', () => {
  const message = buildInboundMessage({ channel: 'qq', userId: 'u1', extId: 'qq-1', text: 'hello', sourceKind: 'qq' })
  assert.ok(message.id.length > 0, 'MessageId 已生成')
  assert.equal(message.role, 'user')
  assert.equal((message.source as { kind: string }).kind, 'qq')
  assert.equal((message.source as { extId: string }).extId, 'qq-1')
})

test('buildInboundMessage 默认 user kind 携带通道溯源字段', () => {
  const message = buildInboundMessage({ channel: 'wechat', userId: 'u2', extId: 'wx-1', text: 'hi', sourceKind: 'user' })
  assert.equal((message.source as { kind: string }).kind, 'user')
  assert.equal((message.source as { channel: string }).channel, 'wechat')
})
