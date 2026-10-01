import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import type { ClaustrumFamily } from '../../src/claustrum/index.ts'
import { makeTempDir } from '../fixtures/scratch.ts'

export const family: ClaustrumFamily = {
  refreshAdapter: 'test-provider',
  category: 'test-native',
}

export interface LogRecord {
  level: 'warn' | 'debug'
  message: string
  data?: unknown
}

export function captureLogger() {
  const records: LogRecord[] = []
  return {
    records,
    logger: {
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
