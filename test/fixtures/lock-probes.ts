import { spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Helpers for tests that pause lock holders and contenders at chosen points
// and watch whether two of them are ever inside their critical sections at
// once.

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Settles with the promise's outcome, or with 'pending' after `ms`. */
export async function settledWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Records which actors are inside their critical sections, and every moment
 * one entered while another was still inside.
 */
export function criticalSections() {
  const inside = new Set<string>()
  const overlaps: string[][] = []
  return {
    overlaps,
    enter(actor: string) {
      if (inside.size > 0) overlaps.push([...inside, actor])
      inside.add(actor)
      return { exit: () => inside.delete(actor) }
    },
  }
}

// The prototype every FileHandle shares. The lock's in-place record writes go
// through FileHandle.write, so spying here reaches them.
const fileHandlePrototype: { write: (...args: never[]) => Promise<unknown> } =
  await (async () => {
    const handle = await fs.open(fileURLToPath(import.meta.url), 'r')
    try {
      return Object.getPrototypeOf(handle)
    } finally {
      await handle.close()
    }
  })()
const originalHandleWrite = fileHandlePrototype.write

/** Performs a FileHandle write with the real implementation. */
export function realHandleWrite(handle: fs.FileHandle, args: unknown[]) {
  return originalHandleWrite.apply(handle, args as never[]) as Promise<{
    bytesWritten: number
    buffer: Buffer
  }>
}

/**
 * Runs `before` ahead of every FileHandle write, then the write itself (or
 * `write`, when given, in its place). Restore with mockRestore().
 */
export function spyOnHandleWrites(
  before: (handle: fs.FileHandle) => Promise<void>,
  write?: (handle: fs.FileHandle, args: unknown[]) => Promise<unknown>,
) {
  return spyOn(fileHandlePrototype, 'write').mockImplementation(async function (
    this: fs.FileHandle,
    ...args: unknown[]
  ) {
    await before(this)
    return write ? write(this, args) : realHandleWrite(this, args)
  } as never)
}
