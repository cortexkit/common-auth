import { select } from '../auth-menu/select.js'
import type { MenuTerminal } from '../auth-menu/terminal.js'
import type { SetupHost } from './types.js'

/** Reuse the terminal selector for a toggle list with an explicit final choice. */
export async function selectSetupHosts(
  terminal: MenuTerminal,
  found: readonly SetupHost[],
): Promise<SetupHost[] | null> {
  const selected = new Set(found)
  for (;;) {
    const choice = await select<SetupHost | 'done'>(
      terminal,
      [
        ...(['opencode', 'pi'] as const).map((host) => ({
          value: host,
          label: `[${selected.has(host) ? 'x' : ' '}] ${host === 'opencode' ? 'OpenCode' : 'Pi'}`,
          hint: found.includes(host) ? 'found' : 'not found',
        })),
        { value: 'done', label: 'Continue with selected hosts' },
      ],
      {
        message: 'Select hosts to set up',
        subtitle: 'Enter toggles a host; choose Continue when ready.',
      },
    )
    if (choice === null) return null
    if (choice === 'done') return [...selected]
    if (selected.has(choice)) selected.delete(choice)
    else selected.add(choice)
  }
}
