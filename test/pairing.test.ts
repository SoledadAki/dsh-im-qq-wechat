import assert from 'node:assert/strict'
import test from 'node:test'

import { PairingCode } from '../src/pairing.js'

test('pairing codes carry 128 bits of entropy instead of six digits', () => {
  const pairing = new PairingCode()
  const first = pairing.issue()
  const second = pairing.issue()
  // base64url of 16 random bytes: the previous code was String(randomInt(100000, 1000000)),
  // i.e. a 900k space any sender able to message the bot could grind.
  assert.equal(Buffer.from(first, 'base64url').length, 16)
  assert.notEqual(first, second)
  // Issuing a new code retires the previous one.
  assert.equal(pairing.check(first), 'mismatch')
  assert.equal(pairing.check(second), 'match')
})

test('a wrong guess never matches and a correct one does', () => {
  const pairing = new PairingCode({ maxAttempts: 5 })
  const code = pairing.issue()
  assert.equal(pairing.active, true)
  assert.equal(pairing.check('nope'), 'mismatch')
  assert.equal(pairing.check(`${code}x`), 'mismatch')
  assert.equal(pairing.check(code), 'match')
})

test('the code expires and reports expired instead of matching', () => {
  let now = 1_000
  const pairing = new PairingCode({ ttlMs: 100, now: () => now })
  const code = pairing.issue()
  assert.equal(pairing.active, true)
  now += 101
  assert.equal(pairing.active, false)
  assert.equal(pairing.check(code), 'expired')
  // The spent code must not become usable again once time moves on.
  now -= 101
  assert.equal(pairing.check(code), 'expired')
})

test('exhausting the attempt budget rotates the code instead of locking the operator out', () => {
  const pairing = new PairingCode({ maxAttempts: 3 })
  const original = pairing.issue()
  assert.equal(pairing.check('a'), 'mismatch')
  assert.equal(pairing.check('b'), 'mismatch')
  assert.equal(pairing.check('c'), 'locked')
  // A guesser must gain nothing, and must not be able to wedge the setup:
  // the stolen/observed old code is dead and a fresh one is now active.
  assert.equal(pairing.check(original), 'mismatch')
  assert.equal(pairing.active, true)
})

test('clear retires the code without issuing a replacement', () => {
  const pairing = new PairingCode()
  const code = pairing.issue()
  pairing.clear()
  assert.equal(pairing.active, false)
  assert.equal(pairing.check(code), 'expired')
})
