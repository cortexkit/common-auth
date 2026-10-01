import { confirm } from './confirm.js'
import { type MenuItem, type SelectOptions, select } from './select.js'
import {
  isInteractive,
  type MenuTerminal,
  printLine,
  processTerminal,
} from './terminal.js'

/** What an action is given to talk to the operator. */
export interface MenuContext {
  terminal: MenuTerminal
  /** Whether keys can be read; false when the menu printed a plain list. */
  interactive: boolean
  print(line?: string): void
  /** A yes/no question; false on a terminal that cannot take keys. */
  confirm(message: string, defaultYes?: boolean): Promise<boolean>
  /** A list choice; null on cancel or on a terminal that cannot take keys. */
  select<T>(
    items: readonly MenuItem<T>[],
    options: SelectOptions,
  ): Promise<T | null>
}

export interface MenuAction {
  id: string
  label: string
  hint?: string
  /**
   * Shown in red and run only after the operator answers yes to `confirm`
   * (or "<label>?"). An action that first asks which account to act on
   * leaves this unset and confirms through its context once it knows.
   */
  destructive?: boolean
  confirm?: string
  run(context: MenuContext): void | Promise<void>
}

export interface RunMenuOptions {
  title: string
  subtitle?: string
  /** Lines shown above the actions, such as the accounts and their state. */
  status?: readonly string[]
  actions: readonly MenuAction[]
  /** Defaults to the current process's terminal. */
  terminal?: MenuTerminal
}

export type MenuOutcome =
  | { status: 'ran'; action: string }
  | { status: 'declined'; action: string }
  | { status: 'failed'; action: string; error: unknown }
  | { status: 'cancelled' }
  | { status: 'not-interactive' }

export function menuContext(terminal: MenuTerminal): MenuContext {
  const interactive = isInteractive(terminal)
  return {
    terminal,
    interactive,
    print: (line) => printLine(terminal, line),
    confirm: (message, defaultYes) => confirm(terminal, message, defaultYes),
    select: async (items, options) =>
      interactive && items.length > 0 ? select(terminal, items, options) : null,
  }
}

function printPlainMenu(
  context: MenuContext,
  options: RunMenuOptions,
): MenuOutcome {
  context.print(options.title)
  if (options.subtitle) context.print(options.subtitle)
  for (const line of options.status ?? []) context.print(`  ${line}`)
  context.print('')
  context.print('Actions:')
  for (const action of options.actions) {
    context.print(
      action.hint
        ? `  - ${action.label} (${action.hint})`
        : `  - ${action.label}`,
    )
  }
  context.print('')
  context.print(
    'This menu needs an interactive terminal to choose an action; nothing was changed.',
  )
  return { status: 'not-interactive' }
}

/**
 * Show the full-screen menu once and run the chosen action. Without an
 * interactive terminal it prints the same content as a plain list and runs
 * nothing, so a piped or scripted login exits cleanly instead of hanging on
 * a key that never comes. An action's failure is printed and reported rather
 * than thrown, because the caller still owes the host its result.
 */
export async function runMenu(options: RunMenuOptions): Promise<MenuOutcome> {
  const terminal = options.terminal ?? processTerminal()
  const context = menuContext(terminal)
  if (!context.interactive) return printPlainMenu(context, options)
  if (options.actions.length === 0) {
    context.print('No actions are available.')
    return { status: 'cancelled' }
  }

  const chosen = await select(
    terminal,
    options.actions.map((action) => ({
      label: action.label,
      value: action,
      color: action.destructive ? ('red' as const) : ('cyan' as const),
      ...(action.hint ? { hint: action.hint } : {}),
    })),
    {
      message: options.title,
      subtitle: options.subtitle ?? 'Select an account action',
      ...(options.status ? { lines: options.status } : {}),
      clearScreen: true,
    },
  )
  if (!chosen) return { status: 'cancelled' }

  if (
    chosen.destructive &&
    !(await context.confirm(chosen.confirm ?? `${chosen.label}?`))
  ) {
    context.print('Cancelled; nothing was changed.')
    return { status: 'declined', action: chosen.id }
  }

  try {
    await chosen.run(context)
    return { status: 'ran', action: chosen.id }
  } catch (error) {
    context.print(
      `${chosen.label} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { status: 'failed', action: chosen.id, error }
  }
}
