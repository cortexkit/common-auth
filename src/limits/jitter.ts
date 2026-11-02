import { createHash } from 'node:crypto'

/** One deterministic pad for the whole hold, not one pad per blocker. */
export function holdDelayMs(sessionId: string, delayMs: number): number {
  const seconds = createHash('sha256')
    .update(sessionId)
    .digest()
    .readUInt32BE(0)
  return 1000 * (Math.max(1, Math.ceil(delayMs / 1000)) + (seconds % 21))
}
