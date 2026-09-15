import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Pairing secrets are short-lived: an abandoned setup must not stay usable. */
export const PAIRING_TTL_MS = 10 * 60_000
/** Wrong guesses allowed before the code is rotated out from under the guesser. */
export const PAIRING_MAX_ATTEMPTS = 5

export type PairingVerdict = 'match' | 'mismatch' | 'expired' | 'locked'

/**
 * Owner-pairing secret for the credential channels (Telegram / Feishu / WeCom).
 *
 * The previous implementation used `String(randomInt(100000, 1000000))`: a
 * six-digit code with no expiry, no attempt limit and a non-constant-time
 * comparison.  Any sender able to reach the bot could grind the 900k space,
 * and a single hit persisted *their* id as `ownerUserId`, which in turn reaches
 * `/work` plus `/safe danger-full-access` — unsandboxed execution on the host.
 *
 * This type makes the code 128-bit, expiring, and self-rotating once the
 * attempt budget is spent.  Rotation (rather than lockout) is deliberate: a
 * remote guesser must not be able to permanently wedge an operator's setup,
 * and the refreshed code is republished through the channel status the settings
 * panel already polls.
 */
export class PairingCode {
  private code = ''
  private expiresAt = 0
  private attempts = 0
  private readonly ttlMs: number
  private readonly maxAttempts: number
  private readonly now: () => number

  constructor(options: { ttlMs?: number; maxAttempts?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? PAIRING_TTL_MS
    this.maxAttempts = options.maxAttempts ?? PAIRING_MAX_ATTEMPTS
    this.now = options.now ?? Date.now
  }

  /** Issue (or reissue) a code, discarding any previous one. */
  issue(): string {
    this.code = randomBytes(16).toString('base64url')
    this.expiresAt = this.now() + this.ttlMs
    this.attempts = 0
    return this.code
  }

  /** Retire the code without issuing a new one (successful claim, unbind). */
  clear(): void {
    this.code = ''
    this.expiresAt = 0
    this.attempts = 0
  }

  /** True while a code is set and still within its TTL. */
  get active(): boolean {
    return this.code !== '' && this.now() < this.expiresAt
  }

  /**
   * Constant-time check of a candidate.  Never throws, and never leaves a
   * spent code usable: an expired code reports `expired`, and exhausting the
   * attempt budget issues a fresh code and reports `locked`.
   */
  check(candidate: string): PairingVerdict {
    if (this.code === '') return 'expired'
    if (this.now() >= this.expiresAt) {
      this.clear()
      return 'expired'
    }
    if (this.attempts >= this.maxAttempts) {
      this.issue()
      return 'locked'
    }
    this.attempts++
    const expected = Buffer.from(this.code, 'utf8')
    const actual = Buffer.from(String(candidate), 'utf8')
    const matched = expected.length === actual.length && timingSafeEqual(expected, actual)
    if (matched) return 'match'
    if (this.attempts >= this.maxAttempts) {
      this.issue()
      return 'locked'
    }
    return 'mismatch'
  }
}
