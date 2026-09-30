// Session pins for `sticky-balanced` routing.
//
// A pin records which row a session was placed on so its prompt cache stays
// warm. The library persists no pin: the caller holds pins (in memory, or in
// a cross-process file it owns) and passes the relevant ones in per call.

export interface StickyPin {
  accountId: string
  /** The row's recorded wire identity when the pin was made, if known. */
  wireIdentity?: string
  /** The request size recorded with the pin; weighs pending bytes. */
  inputBytes?: number
  /** The projection time the placement was judged on. */
  quotaCheckedAt?: number
}

/**
 * A pin survives while its row id is in `validIds` and the row still holds
 * the account it was placed on. Only two known, differing identities prove
 * the account changed: an unknown identity on either side keeps the pin,
 * because re-placing a session on missing evidence throws its cache away.
 */
export function isPinValid(
  pin: StickyPin,
  validIds: ReadonlySet<string>,
  currentIdentity: string | undefined,
): boolean {
  if (!validIds.has(pin.accountId)) return false
  return !(
    typeof pin.wireIdentity === 'string' &&
    typeof currentIdentity === 'string' &&
    pin.wireIdentity !== currentIdentity
  )
}

/**
 * Sums the request bytes of every other session's pin per row, as openai-auth
 * does. A pin counts only while it was judged on the row's current
 * projection time, so a fresh reading resets the row's pending load.
 */
export function pendingBytesForPins(
  pins: Iterable<readonly [sessionKey: string, pin: StickyPin]>,
  quotaCheckedAtById: ReadonlyMap<string, number | undefined>,
  excludedSessionKey?: string,
): Map<string, number> {
  const pending = new Map<string, number>()
  for (const [sessionKey, pin] of pins) {
    if (sessionKey === excludedSessionKey) continue
    if (pin.quotaCheckedAt !== quotaCheckedAtById.get(pin.accountId)) continue
    pending.set(
      pin.accountId,
      (pending.get(pin.accountId) ?? 0) + (pin.inputBytes ?? 0),
    )
  }
  return pending
}
