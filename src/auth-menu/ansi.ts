/** ANSI controls used by the first-party auth menu. */
export const ANSI = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  up: (n = 1) => `\x1b[${n}A`,
  clearLine: '\x1b[2K',
  clearScreen: '\x1b[2J',
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const

export type KeyAction =
  | 'up'
  | 'down'
  | 'enter'
  | 'escape'
  | 'escape-start'
  | null

/** Convert terminal key bytes into the small action set the menu accepts. */
export function parseKey(data: Buffer | string): KeyAction {
  const value = data.toString()
  if (value === '\x1b[A' || value === '\x1bOA') return 'up'
  if (value === '\x1b[B' || value === '\x1bOB') return 'down'
  if (value === '\r' || value === '\n') return 'enter'
  if (value === '\x03') return 'escape'
  if (value === '\x1b') return 'escape-start'
  return null
}

const ANSI_PATTERN = `${String.fromCharCode(27)}\\[[0-9;]*m`
const ANSI_REGEX = new RegExp(ANSI_PATTERN, 'g')
const ANSI_LEADING_REGEX = new RegExp(`^${ANSI_PATTERN}`)

/** Remove colour codes, leaving the text an operator sees. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '')
}

/**
 * Shorten coloured text to a visible width without cutting an escape code in
 * half, resetting the colour before the ellipsis so it cannot bleed.
 */
export function truncateAnsi(input: string, maxVisibleChars: number): string {
  if (maxVisibleChars <= 0) return ''
  if (stripAnsi(input).length <= maxVisibleChars) return input

  const suffix = maxVisibleChars >= 3 ? '...' : '.'.repeat(maxVisibleChars)
  const keep = Math.max(0, maxVisibleChars - suffix.length)
  let output = ''
  let offset = 0
  let visible = 0

  while (offset < input.length && visible < keep) {
    if (input[offset] === '\x1b') {
      const match = input.slice(offset).match(ANSI_LEADING_REGEX)
      if (match) {
        output += match[0]
        offset += match[0].length
        continue
      }
    }
    output += input[offset]
    offset += 1
    visible += 1
  }

  return output.includes('\x1b[')
    ? `${output}${ANSI.reset}${suffix}`
    : output + suffix
}
