/**
 * The declined-account interlock: the user's "do not use this vault account",
 * kept on the consumer side because the vault has no notion of it.
 *
 * An entry is keyed on the credential id plus the provider identity the
 * credential logged into, never on the record version, so a token refresh
 * cannot lift it. It is sticky whenever either side's identity is unknown: an
 * adapter that makes no identity claim cannot prove the account changed. It
 * lifts on its own only when both identities are known and differ, which
 * means the credential now logs into a different account than the one the
 * user declined.
 */
export interface DeclinedAccount {
  readonly credentialId: string
  readonly accountIdentity?: string
}

function matches(
  entry: DeclinedAccount,
  credentialId: string,
  accountIdentity: string | undefined,
): boolean {
  return (
    entry.credentialId === credentialId &&
    (entry.accountIdentity === undefined ||
      accountIdentity === undefined ||
      entry.accountIdentity === accountIdentity)
  )
}

export function isDeclined(
  entries: readonly DeclinedAccount[],
  credentialId: string,
  accountIdentity?: string,
): boolean {
  return entries.some((entry) => matches(entry, credentialId, accountIdentity))
}

/**
 * Drop entries the vault has proven stale: the same credential id now listed
 * with a known identity that differs from the declined one. Entries for
 * credentials that are not listed stay, so an account that leaves and comes
 * back is still declined.
 */
export function pruneDeclined(
  entries: readonly DeclinedAccount[],
  listed: readonly { credentialId: string; accountIdentity?: string }[],
): DeclinedAccount[] {
  return entries.filter((entry) => {
    const current = listed.find(
      (credential) => credential.credentialId === entry.credentialId,
    )
    return !(
      current &&
      entry.accountIdentity !== undefined &&
      current.accountIdentity !== undefined &&
      current.accountIdentity !== entry.accountIdentity
    )
  })
}

export function declineAccount(
  entries: readonly DeclinedAccount[],
  credentialId: string,
  accountIdentity?: string,
): DeclinedAccount[] {
  return [
    ...entries.filter((entry) => entry.credentialId !== credentialId),
    {
      credentialId,
      ...(accountIdentity !== undefined && { accountIdentity }),
    },
  ]
}

export function acceptAccount(
  entries: readonly DeclinedAccount[],
  credentialIds: readonly string[],
): DeclinedAccount[] {
  return entries.filter((entry) => !credentialIds.includes(entry.credentialId))
}
