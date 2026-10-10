import type { NotifyKind, PiMenuUi } from '../../src/commands/index.js'

/**
 * One scripted answer. `select` picks the first option starting with the
 * text (undefined backs out); `input` types the text; `confirm` answers.
 */
export type Step =
  | { select: string | undefined }
  | { input: string | undefined }
  | { confirm: boolean }

export interface FakePiUi extends PiMenuUi {
  calls: string[]
  /** Every select's whole title, lines included, in order. */
  titles: string[]
  notified: Array<{ message: string; type: NotifyKind | undefined }>
  /** Steps not consumed when the run ended. */
  remaining(): number
}

/**
 * A Pi UI driven by a script. A prompt of the wrong kind, or a select whose
 * text matches no option, fails the run. Once the script runs out, every
 * select backs out, so the renderer climbs back up and ends.
 */
export function fakePiUi(script: Step[]): FakePiUi {
  const steps = [...script]
  const calls: string[] = []
  const titles: string[] = []
  const notified: FakePiUi['notified'] = []
  const next = (kind: 'select' | 'input' | 'confirm', title: string) => {
    const step = steps.shift()
    if (step === undefined) return undefined
    if (!(kind in step))
      throw new Error(
        `expected ${Object.keys(step)[0]} but the renderer asked ${kind}: ${title}`,
      )
    return step
  }
  return {
    calls,
    titles,
    notified,
    remaining: () => steps.length,
    async select(title, options) {
      calls.push(`select ${title.split('\n')[0]} [${options.join(' | ')}]`)
      titles.push(title)
      const step = next('select', title) as { select: string | undefined }
      if (!step || step.select === undefined) return undefined
      const prefix = step.select
      const option = options.find((entry) => entry.startsWith(prefix))
      if (option === undefined)
        throw new Error(
          `no option starts with ${prefix}: ${options.join(' | ')}`,
        )
      return option
    },
    async input(title, placeholder) {
      calls.push(`input ${title} (${placeholder ?? ''})`)
      const step = next('input', title) as { input: string | undefined }
      return step?.input
    },
    async confirm(title, message) {
      calls.push(`confirm ${title}: ${message}`)
      const step = next('confirm', title) as { confirm: boolean } | undefined
      return step?.confirm ?? false
    },
    notify(message, type) {
      notified.push({ message, type })
    },
  }
}
