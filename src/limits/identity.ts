import { sameAccount } from './request-history.js'
import type { AccountKey } from './signal.js'

/** Binding metadata is not part of the timed-mark lookup key. */
export interface IdentityBinding {
  readonly account: AccountKey
  readonly identity?: string
  readonly credentialEpoch: string
}

/** Compatibility is a wildcard test, not a transitive identity equivalence. */
export function isIdentityCompatible(
  a: IdentityBinding,
  b: IdentityBinding,
): boolean {
  return (
    sameAccount(a.account, b.account) &&
    (a.identity === undefined ||
      b.identity === undefined ||
      a.identity === b.identity)
  )
}

/** An unknown observation must not erase a previously verified identity. */
export function retainVerifiedIdentity(
  previous: IdentityBinding,
  current: IdentityBinding,
): IdentityBinding {
  if (!isIdentityCompatible(previous, current)) return current
  return { ...current, identity: current.identity ?? previous.identity }
}

/** Called with bindings read under the adapter's commit lock, including on refresh. */
export type AuthorizeCredentialEpoch = (
  observed: IdentityBinding,
  authoritative: IdentityBinding,
) => boolean

export function validateIdentityFence(
  observed: IdentityBinding,
  authoritative: IdentityBinding,
  authorizeEpoch: AuthorizeCredentialEpoch,
): 'identity-replaced' | 'credential-epoch' | undefined {
  if (!isIdentityCompatible(observed, authoritative)) return 'identity-replaced'
  if (!authorizeEpoch(observed, authoritative)) return 'credential-epoch'
  return undefined
}
