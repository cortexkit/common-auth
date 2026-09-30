import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolStore,
  type QuotaCodec,
} from '../../src/store/index.js'
import { makeTempDir } from '../fixtures/scratch.js'

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
  cleanup(): void
}

export async function scenario(prefix = 'pool-store-'): Promise<Scenario> {
  const dir = await makeTempDir(prefix)
  const configPath = join(dir, 'openai-auth.json')
  const statePath = join(dir, 'openai-auth-state.json')
  const read = async (path: string) =>
    existsSync(path) ? await readFile(path, 'utf8') : null
  return {
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

export async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ])
  if (timer) clearTimeout(timer)
  return result
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
}

/** Runs one store operation in a separate process (see child.ts). */
export function runChild(task: Record<string, unknown>): ChildHandle {
  const child = spawn(process.execPath, [childScript, JSON.stringify(task)], {
    stdio: ['ignore', 'pipe', 'pipe'],
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
    exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
    printed: (marker) =>
      new Promise<void>((resolve) => {
        if (out.includes(marker)) resolve()
        else waiters.push({ marker, resolve })
      }),
    output: () => out,
  }
}

/** The exit code a child uses when it stops itself at a named write step. */
export const CRASH_EXIT_CODE = 17
