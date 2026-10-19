import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ClaustrumClient,
  type ScopedInventoryRow,
} from '@cortexkit/claustrum-client'
import type { ClaustrumFamily } from '../../src/claustrum/index.ts'
import { makeTempDir } from '../fixtures/scratch.ts'

export const family: ClaustrumFamily = {
  refreshAdapter: 'test-provider',
  category: 'test-native',
}

export interface LogRecord {
  level: 'info' | 'warn' | 'debug'
  message: string
  data?: unknown
}

export function captureLogger() {
  const records: LogRecord[] = []
  return {
    records,
    logger: {
      info: (message: string, data?: unknown) =>
        records.push({ level: 'info', message, data }),
      warn: (message: string, data?: unknown) =>
        records.push({ level: 'warn', message, data }),
      debug: (message: string, data?: unknown) =>
        records.push({ level: 'debug', message, data }),
    },
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

export function inventoryRow(
  overrides: Partial<ScopedInventoryRow> = {},
): ScopedInventoryRow {
  return {
    id: 'oauth:test:work',
    accountId: 'account-1',
    categories: [family.category],
    credentialType: 'oauth',
    refreshAdapter: family.refreshAdapter,
    serves: ['test-vendor'],
    providerIds: [],
    operations: ['read'],
    state: 'active',
    recordVersion: 1,
    createdAtMs: null,
    ...overrides,
  }
}

const dirs: string[] = []

/** A fresh directory removed by `cleanupDirs` after each test. */
export async function tempDir(prefix = 'claustrum-'): Promise<string> {
  const dir = await makeTempDir(prefix)
  dirs.push(dir)
  return dir
}

export async function cleanupDirs(): Promise<void> {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
}

export async function writeToken(
  dir: string,
  token = '01'.repeat(32),
  name = 'token.json',
): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify({ token, token_generation: 1 }), {
    mode: 0o600,
  })
  return path
}

/**
 * The grant fields claustrum-client 0.10.0 added to `listScoped`'s reply, as
 * they are when the vault is too old to send them (unknown). Spread into a
 * fake reply so it type-checks against both 0.10.0 and 0.6.2, the oldest
 * client the peer dependency accepts, where the fields do not exist.
 */
export const unknownGrants = {
  grants: undefined,
  grantTuples: undefined,
} as const

/**
 * Whether the installed claustrum-client decodes `listScoped`'s grant fields
 * (0.10.0 and later). `check:claustrum-floor` also runs these tests against
 * 0.6.2, the oldest client the peer dependency accepts, which ignores the
 * fields, so a vault that sends them still reads as unknown there.
 */
export const clientDecodesGrants = await (async () => {
  let directory = dirname(
    fileURLToPath(import.meta.resolve('@cortexkit/claustrum-client')),
  )
  for (;;) {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8')
      .then((text) => JSON.parse(text) as { name?: string; version?: string })
      .catch(() => undefined)
    if (manifest?.name === '@cortexkit/claustrum-client') {
      const [major = 0, minor = 0] = (manifest.version ?? '')
        .split('.')
        .map(Number)
      return major > 0 || minor >= 10
    }
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error('cannot find the claustrum-client package manifest')
    directory = parent
  }
})()

/**
 * Timers the consumer arms are recorded and fired by the test, so polling
 * pace is asserted from the delays armed rather than from waiting.
 */
export function fakeTimers() {
  interface Timer {
    delay: number
    run: () => void
    done: boolean
    unref(): void
  }
  const armed: Timer[] = []
  return {
    setTimeoutImpl: ((run: () => void, delay: number) => {
      const timer: Timer = { delay, run, done: false, unref() {} }
      armed.push(timer)
      return timer
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((timer: Timer | undefined) => {
      if (timer) timer.done = true
    }) as unknown as typeof clearTimeout,
    /** Delays of the timers armed and not yet fired or cleared. */
    pending: () =>
      armed.filter((timer) => !timer.done).map((timer) => timer.delay),
    fire(delay: number) {
      const timer = armed.find((each) => !each.done && each.delay === delay)
      if (!timer) throw new Error(`no timer armed for ${delay} ms`)
      timer.done = true
      timer.run()
    },
  }
}

/** Waits for real socket traffic with the mock daemon to land. */
export async function until(
  predicate: () => boolean,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(2)
  }
}

/**
 * Whether the installed claustrum-client can watch (0.12.0 and later).
 * `check:claustrum-floor` also runs these tests against 0.6.2, which cannot, so
 * the tests that need a real watching client are skipped there and the
 * fallback tests run instead.
 */
export const clientWatches = 'watchScoped' in ClaustrumClient.prototype
