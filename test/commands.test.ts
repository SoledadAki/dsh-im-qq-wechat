import assert from 'node:assert/strict'
import test from 'node:test'

import { BRIDGE_HELP, formatTokenCount, parseBridgeCommand } from '../src/commands.js'

test('ordinary chat is not consumed as a control command', () => {
  assert.equal(parseBridgeCommand('帮我制作一个网页'), undefined)
})

test('short project and session commands are parsed', () => {
  assert.deepEqual(parseBridgeCommand('/new 官网'), { kind: 'new', name: '官网' })
  assert.deepEqual(parseBridgeCommand('/work "E:\\AI Work\\site"'), { kind: 'work', path: 'E:\\AI Work\\site' })
  assert.deepEqual(parseBridgeCommand('/use 2'), { kind: 'use', selector: '2' })
  assert.deepEqual(parseBridgeCommand('/st'), { kind: 'status' })
  assert.deepEqual(parseBridgeCommand('/停止'), { kind: 'stop' })
  assert.deepEqual(parseBridgeCommand('/reset'), { kind: 'reset' })
  assert.deepEqual(parseBridgeCommand('/重置'), { kind: 'reset' })
  assert.deepEqual(parseBridgeCommand('/clear'), { kind: 'reset' })
  assert.deepEqual(parseBridgeCommand('/model'), { kind: 'model' })
  assert.deepEqual(parseBridgeCommand('/模型 2'), { kind: 'model', selector: '2' })
  assert.deepEqual(parseBridgeCommand('/model deepseek/deepseek-chat'), { kind: 'model', selector: 'deepseek/deepseek-chat' })
})

test('thinking and safety aliases map to Harness values', () => {
  assert.deepEqual(parseBridgeCommand('/think off'), { kind: 'think', effort: 'off' })
  assert.deepEqual(parseBridgeCommand('/THINK HIGH'), { kind: 'think', effort: 'high' })
  assert.deepEqual(parseBridgeCommand('/effort max'), { kind: 'think', effort: 'max' })
  assert.deepEqual(parseBridgeCommand('/思考 关闭'), { kind: 'think', effort: 'off' })
  assert.deepEqual(parseBridgeCommand('/思考 极限'), { kind: 'think', effort: 'max' })
  assert.deepEqual(parseBridgeCommand('/safe 只读'), { kind: 'safe', preset: 'read-only' })
  assert.deepEqual(parseBridgeCommand('/安全 写入'), { kind: 'safe', preset: 'workspace-write' })
  assert.deepEqual(parseBridgeCommand('/safe full'), { kind: 'safe', preset: 'danger-full-access' })
})

test('unknown slash commands are contained by the bridge', () => {
  assert.deepEqual(parseBridgeCommand('/wat'), { kind: 'unknown', name: 'wat' })
})

test('context token counts use compact startup-card labels', () => {
  assert.equal(formatTokenCount(1_000_000), '1.0M tokens')
  assert.equal(formatTokenCount(128_000), '128K tokens')
  assert.equal(formatTokenCount(32_768), '32.8K tokens')
})

test('help stays concise while compatibility aliases remain accepted', () => {
  for (const hidden of ['/project', '/sessions', '/switch', '/cancel', '/effort', '/permission']) {
    assert.equal(BRIDGE_HELP.includes(hidden), false)
  }
  assert.deepEqual(parseBridgeCommand('/sessions'), { kind: 'list' })
  assert.deepEqual(parseBridgeCommand('/cancel'), { kind: 'stop' })
})
