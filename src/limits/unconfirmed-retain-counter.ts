import { sameAccount } from './request-history.js'
import type { AccountKey } from './signal.js'

/** Plugin-owned turn budgets, independent of individual logical request histories. */
export class UnconfirmedRetainCounter {
  private readonly sessions = new Map<
    string,
    { turnId: string; account: AccountKey; count: number }
  >()

  constructor(private readonly maxSessions = 4096) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1)
      throw new RangeError('maxSessions must be a positive safe integer')
  }

  count(sessionId: string, turnId: string, account: AccountKey): number {
    const entry = this.sessions.get(sessionId)
    return entry?.turnId === turnId && sameAccount(entry.account, account)
      ? entry.count
      : 0
  }

  /** Call once after accepting a decision with incrementUnconfirmedRetain. */
  increment(sessionId: string, turnId: string, account: AccountKey): void {
    const count = this.count(sessionId, turnId, account)
    if (!count) {
      this.sessions.delete(sessionId)
      if (this.sessions.size >= this.maxSessions) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined) this.sessions.delete(oldest)
      }
    }
    this.sessions.set(sessionId, {
      turnId,
      account: { ...account },
      count: count + 1,
    })
  }

  /** Clear on moves, API fallback and session lifecycle boundaries. */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  clearAll(): void {
    this.sessions.clear()
  }
}
