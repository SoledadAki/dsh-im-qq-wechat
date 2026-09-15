import type { CredentialAccess } from './sidecar-channel.js'

/**
 * Best-effort credential removal.
 *
 * `unset` legitimately fails for references supplied by the launch environment
 * (`dsh-credentials-local` refuses to mutate those).  Revocation must not abort
 * halfway because of that: the caller still has to clear its persisted binding
 * and status, otherwise the channel keeps reporting `bound` — with a live owner
 * and the old secret still resolvable — after the operator pressed 解绑.
 *
 * @returns false when the secret could not be removed, so the caller can say so
 * in its log instead of silently pretending the credential is gone.
 */
export async function unsetCredentialBestEffort(
  credentials: Pick<CredentialAccess, 'unset'>,
  ref: string,
): Promise<boolean> {
  try {
    await credentials.unset(ref)
    return true
  } catch {
    return false
  }
}
