import { expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolStore,
  type ProviderStateCodec,
  type QuotaCodec,
} from '../../src/store/index.js'
import { observed } from '../fixtures/observed.js'
import { makeTempDir } from '../fixtures/scratch.js'
import type { TestLifetime } from '../fixtures/test-lifetime.js'

/** A trivial quota codec: the map is a list of observations in arrival order. */
export const listCodec: QuotaCodec = {
  validate: (value) =>
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { readings?: unknown }).readings),
  merge: (stored, observation) => ({
    readings: [
      ...((stored as { readings?: unknown[] } | undefined)?.readings ?? []),
      observation,
    ],
  }),
}

/**
 * A provider-state codec that accepts any plain object and binds all of it to
 * the credential. The child process opens its store with it when a task
 * carries a provider state, so both processes compute the same digests.
 */
export const objectStateCodec: ProviderStateCodec = {
  validate: (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value),
}

// Parsed store files are inspected field by field in assertions.
// biome-ignore lint/suspicious/noExplicitAny: arbitrary parsed JSON
export type ParsedJson = Record<string, any>

export interface Scenario {
  dir: string
  configPath: string
  statePath: string
  paths: { configPath: string; statePath: string }
  open(overrides?: Partial<OpenPoolStoreOptions>): PoolStore
  config(): Promise<ParsedJson>
  state(): Promise<ParsedJson>
  bytes(): Promise<{ config: string | null; state: string | null }>
  writeConfig(value: unknown): Promise<void>
  writeState(value: unknown): Promise<void>
  contended(lifetime: TestLifetime, name: string, path?: string): Promise<void>
  cleanup(): void
}

export async function scenario(prefix = 'pool-store-'): Promise<Scenario> {
  const dir = await makeTempDir(prefix)
  const configPath = join(dir, 'openai-auth.json')
  const statePath = join(dir, 'openai-auth-state.json')
  const read = async (path: string) =>
    existsSync(path) ? await readFile(path, 'utf8') : null
  const refusals: Array<{ name: string; path: string }> = []
  const waiters: Array<{ name: string; path: string; resolve: () => void }> = []
  return {
    contended: (lifetime, name, path = statePath) =>
      observed(
        lifetime,
        new Promise<void>((resolve) => {
          const index = refusals.findIndex(
            (event) => event.name === name && event.path === path,
          )
          if (index >= 0) {
            refusals.splice(index, 1)
            resolve()
          } else waiters.push({ name, path, resolve })
        }),
      ),
    dir,
    configPath,
    statePath,
    paths: { configPath, statePath },
    open: (overrides = {}) =>
      openPoolStore({
        provider: 'openai',
        configPath,
        statePath,
        quota: listCodec,
        ...overrides,
        onLockEvent: (event) => {
          if (event.type === 'contended') {
            const index = waiters.findIndex(
              (waiter) =>
                waiter.name === event.name && waiter.path === event.path,
            )
            if (index >= 0) waiters.splice(index, 1)[0]?.resolve()
            else refusals.push(event)
          }
          overrides.onLockEvent?.(event)
        },
      }),
    config: async () => JSON.parse((await read(configPath)) ?? 'null'),
    state: async () => JSON.parse((await read(statePath)) ?? 'null'),
    bytes: async () => ({
      config: await read(configPath),
      state: await read(statePath),
    }),
    writeConfig: (value) =>
      writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`),
    writeState: (value) =>
      writeFile(statePath, `${JSON.stringify(value, null, 2)}\n`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export function oauth(refresh: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'oauth' as const,
    access: `access-${refresh}`,
    refresh,
    expires: 4_000_000_000_000,
    ...extra,
  }
}

export function apiKey(key: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'api' as const,
    apiKey: key,
    baseURL: 'https://api.example.test/v1',
    ...extra,
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Assert exclusion after a refused attempt; teardown cancels a missing observation. */
export async function blocked(
  lifetime: TestLifetime,
  operation: Promise<unknown>,
  refusal: Promise<void>,
): Promise<void> {
  let settled = false
  void operation.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await observed(lifetime, refusal)
  expect(settled).toBe(false)
}

/** Awaits a promise expected to reject and returns the rejection. */
// biome-ignore lint/suspicious/noExplicitAny: callers assert on the error's fields
export async function rejectionOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

/** Overwrites a lock file with a foreign owner, so the holder's lease is lost. */
export async function stealLease(path: string, name: string): Promise<void> {
  await writeFile(
    `${path}.${name}.lock`,
    `${JSON.stringify({ ownerId: 'thief', expiresAt: Date.now() + 60_000 })}\n`,
  )
}

const childScript = fileURLToPath(new URL('./child.ts', import.meta.url))

export interface ChildHandle {
  /** Resolves with the child's exit code. */
  exited: Promise<number | null>
  /** Resolves when the child prints the given marker line. */
  printed(marker: string): Promise<void>
  output(): string
  /** Releases a child parked for the parent's live-lease read. */
  continue(): void
}

interface ChildLease {
  path: string
  ownerId: string
  expiresAt: number
  acquiredAt: number
}

export function childLeases(output: string): ChildLease[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('lease:'))
    .map((line) => JSON.parse(line.slice('lease:'.length)) as ChildLease)
}

/**
 * Called only after confirmed child exit and drained output: it cannot renew any more.
 * Write the same newline-terminated owner/expiry JSON as lease renewal, with
 * an expired timestamp, so normal acquisition reaps the abandoned record.
 * Ownership matching avoids expiring a survivor that has already taken over.
 */
export async function expireChildLeases(output: string): Promise<void> {
  for (const lease of childLeases(output)) {
    const handle = await open(lease.path, 'r+')
    try {
      const record = JSON.parse(await handle.readFile('utf8'))
      if (record.ownerId !== lease.ownerId) continue
      const bytes = Buffer.from(
        `${JSON.stringify({ ownerId: record.ownerId, expiresAt: 0 })}\n`,
      )
      // Keep the opened inode: a replacement at the path must not be expired.
      await handle.write(bytes, 0, bytes.length, 0)
      await handle.truncate(bytes.length)
    } finally {
      await handle.close()
    }
  }
}

/** Runs one store operation; crashed leases are expired after confirmed exit. */
export function runChild(task: Record<string, unknown>): ChildHandle {
  const child = spawn(process.execPath, [childScript, JSON.stringify(task)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  const waiters: Array<{ marker: string; resolve: () => void }> = []
  const onData = (chunk: Buffer) => {
    out += chunk.toString()
    for (const waiter of [...waiters]) {
      if (out.includes(waiter.marker)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  return {
    // close follows exit and drains the lease announcements from stdout.
    exited: new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => {
        const cleanup =
          code === CRASH_EXIT_CODE ? expireChildLeases(out) : Promise.resolve()
        cleanup.then(() => resolve(code), reject)
      })
    }),
    printed: (marker) =>
      new Promise<void>((resolve) => {
        if (out.includes(marker)) resolve()
        else waiters.push({ marker, resolve })
      }),
    output: () => out,
    continue: () => child.stdin.end('continue\n'),
  }
}

/** The exit code a child uses when it stops itself at a named write step. */
export const CRASH_EXIT_CODE = 17
