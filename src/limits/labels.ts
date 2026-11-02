import { hasUnsafeWording } from './wording.js'

const emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/

export function containsEmail(text: string): boolean {
  return emailPattern.test(text)
}

/** Re-login guidance may use user labels, but must not expose emails or cause replay. */
export function sanitizeRefusalLabel(label: string): string {
  return containsEmail(label) || hasUnsafeWording(label)
    ? 'this account'
    : label
}
