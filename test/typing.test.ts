import assert from 'node:assert/strict'
import test from 'node:test'
import { sendTypingBestEffort } from '../src/channel.js'

test('incoming turns proceed when a channel has no typing indicator', async () => {
  await assert.doesNotReject(sendTypingBestEffort({}, 'owner', 'message'))
})

test('a rejected typing indicator does not fail the incoming turn', async () => {
  await assert.doesNotReject(sendTypingBestEffort({
    async sendTyping() { throw new Error('typing unsupported') },
  }, 'owner', 'message'))
})
