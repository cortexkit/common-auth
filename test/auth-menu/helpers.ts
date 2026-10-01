import { ANSI, stripAnsi } from '../../src/auth-menu/ansi.js'
import type { MenuTerminal } from '../../src/auth-menu/terminal.js'

export const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  ctrlC: '\x03',
  escape: '\x1b',
} as const

/** The keys that move down `steps` items and choose the one there. */
export function choose(steps: number): string[] {
  return [...Array.from({ length: steps }, () => KEY.down), KEY.enter]
}

/** Answers "Yes" to a confirmation, whose items are No then Yes. */
export const YES = choose(1)
/** Answers "No" to a confirmation. */
export const NO = choose(0)

type Listener = (data: Buffer | string) => void

export interface FakeTerminal {
  terminal: MenuTerminal
  /** Everything written, with colour codes removed. */
  text(): string
  /** Each full-screen redraw, with colour codes removed. */
  frames(): string[]
  /** Keys not yet delivered. */
  pending(): number
  /** Every raw-mode change, in order. */
  rawModes: boolean[]
  listening(): number
}

/**
 * A terminal that feeds the scripted keys one at a time to whatever is
 * listening, each on its own timer turn so a selector redraws between them,
 * and records every byte written.
 */
export function fakeTerminal(
  keys: readonly string[],
  options: { tty?: boolean; columns?: number; rows?: number } = {},
): FakeTerminal {
  const listeners = new Set<Listener>()
  const queue = [...keys]
  const writes: string[] = []
  const rawModes: boolean[] = []
  let raw = false
  let scheduled = false

  const schedule = () => {
    if (scheduled || queue.length === 0 || listeners.size === 0) return
    scheduled = true
    setTimeout(pump, 0)
  }
  const pump = () => {
    scheduled = false
    if (listeners.size === 0) return
    const key = queue.shift()
    if (key === undefined) return
    for (const listener of [...listeners]) listener(key)
    schedule()
  }

  const terminal: MenuTerminal = {
    input: {
      isTTY: options.tty ?? true,
      get isRaw() {
        return raw
      },
      setRawMode(mode: boolean) {
        raw = mode
        rawModes.push(mode)
      },
      resume() {},
      pause() {},
      on(_event: 'data', listener: Listener) {
        listeners.add(listener)
        schedule()
      },
      removeListener(_event: 'data', listener: Listener) {
        listeners.delete(listener)
      },
    },
    output: {
      write(text: string) {
        writes.push(text)
      },
      columns: options.columns ?? 100,
      rows: options.rows ?? 40,
    },
  }

  return {
    terminal,
    text: () => stripAnsi(writes.join('')),
    frames: () =>
      writes
        .join('')
        .split(ANSI.clearScreen)
        .slice(1)
        .map((frame) => stripAnsi(frame)),
    pending: () => queue.length,
    rawModes,
    listening: () => listeners.size,
  }
}
