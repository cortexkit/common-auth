import { mock } from 'bun:test'
import {
  type CacheKeepAdapter,
  CacheKeepManager,
  type CacheKeepManagerOptions,
  type CacheKeepSendInput,
} from '../../src/cachekeep/index.js'

export const TTL_MS = 5 * 60 * 1000
export const LEAD_MS = 5 * 1000
/** A tick inside the lead window of a target captured `TTL_MS` ago. */
export const DUE_MS = TTL_MS - LEAD_MS + 1000

export function fakeNow(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

export function fakeLogger() {
  return {
    debug: mock((_message: string, _data?: unknown) => {}),
    warn: mock((_message: string, _data?: unknown) => {}),
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type Meta = { headers?: Record<string, string> } | undefined

export type SendMock = ReturnType<
  typeof mock<(input: CacheKeepSendInput<Meta>) => Promise<Response>>
>

/**
 * A manager over a recording adapter. The replay body is the captured body
 * with `"warm": true` added, so a test can tell which capture was replayed;
 * a capture that is not JSON makes it throw, as a provider body builder would.
 */
export function makeManager(
  clock: ReturnType<typeof fakeNow>,
  options: Partial<CacheKeepManagerOptions<Meta>> = {},
  adapter: Partial<CacheKeepAdapter<Meta>> & {
    send?: (input: CacheKeepSendInput<Meta>) => Promise<Response>
  } = {},
) {
  const log = fakeLogger()
  const send: SendMock = mock(adapter.send ?? (async () => new Response('{}')))
  const mgr = new CacheKeepManager<Meta>({
    now: clock.now,
    logger: log,
    ttlMs: TTL_MS,
    leadMs: LEAD_MS,
    ...options,
    adapter: {
      buildBody: (target) =>
        JSON.stringify({ ...JSON.parse(target.bodyText), warm: true }),
      ...adapter,
      send,
    },
  })
  return { mgr, send, log }
}

export function body(input: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ input, ...extra })
}

export function sessions(mgr: CacheKeepManager<Meta>): string[] {
  return mgr.status().targets.map((target) => target.sessionKey)
}
