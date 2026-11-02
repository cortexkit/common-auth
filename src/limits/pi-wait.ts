import { formatDuration } from './duration.js'

export type PiWaitResult = 'elapsed' | 'aborted'

export interface PiWaitOptions {
  /** Forward the Pi stream's options.signal so cancellation ends the wait. */
  signal?: AbortSignal
  setWorkingMessage: (text?: string) => void
}

/**
 * Wait in the caller's Pi stream without sending or selecting an account.
 * After 'elapsed', the caller must re-check that the account remains eligible,
 * its identity has not been replaced, and its credentials are still available
 * for use. When waiting to reuse the same account's prompt cache, also check
 * that the session's activity record still belongs to that account incarnation
 * and that the wait target does not exceed its cache expiry. Only then send.
 * After 'aborted', end the stream without a refusal; abort never rejects.
 */
export function waitForPi(
  delayMs: number,
  options: PiWaitOptions,
): Promise<PiWaitResult> {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('Pi wait requires a finite non-negative delay')
  }
  return new Promise((resolve) => {
    const target = Date.now() + delayMs
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const workingMessage = (text?: string) => {
      // A presentation failure must not strand the stream or mask cancellation.
      try {
        options.setWorkingMessage(text)
      } catch {}
    }
    const finish = (result: PiWaitResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      workingMessage()
      resolve(result)
    }
    const abort = () => finish('aborted')
    const tick = () => {
      const remaining = target - Date.now()
      if (remaining <= 0) return finish('elapsed')
      workingMessage(`Waiting: ${formatDuration(remaining)}`)
      // The callback may itself cancel the stream. Do not arm a timer afterward.
      if (!settled) timer = setTimeout(tick, Math.min(1000, remaining))
    }

    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    else tick()
  })
}
