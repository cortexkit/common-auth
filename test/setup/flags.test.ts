import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { parseSetupFlags, SETUP_FLAGS } from '../../src/setup/flags.js'
import {
  runSetup,
  type SetupPlugin,
  setupUsage,
} from '../../src/setup/index.js'
import { fakeIO, plugin, terminal } from './helpers.js'

const UNAVAILABLE_HOST =
  'Requested setup host is unknown or unavailable. Use --host=opencode or --host=pi with a detected host.'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'common-auth-setup-flags-'))
  roots.push(root)
  return root
}

/** A plugin with no `migrate`, like a vault-only plugin that has nothing to move. */
function withoutMigrate(root?: string): SetupPlugin {
  const { migrate: _migrate, ...rest } = plugin(root)
  return rest
}

describe('optional migrate', () => {
  test('a dry run without migrate plans no migration and is otherwise unchanged', async () => {
    const run = async (p: SetupPlugin) => {
      const io = fakeIO()
      io.files.set('/bin/opencode', '')
      io.files.set('/bin/pi', '')
      const term = terminal()
      const result = await runSetup(p, ['--yes', '--dry-run'], {
        ...io,
        terminal: term,
      })
      expect(result.hosts).toEqual(['opencode', 'pi'])
      return term.lines.join('')
    }
    const withMigrate = await run(plugin())
    const without = await run(withoutMigrate())
    const migrateLines = [
      'Would migrate opencode using the plugin callback (provider-specific writes).\n',
      'Would migrate pi using the plugin callback (provider-specific writes).\n',
    ]
    for (const line of migrateLines) expect(withMigrate).toContain(line)
    expect(without).not.toContain('Would migrate')
    // Leaving out migrate drops exactly those lines and nothing else.
    expect(without).toBe(
      migrateLines.reduce(
        (output, line) => output.replace(line, ''),
        withMigrate,
      ),
    )
  })

  test('a real run without migrate registers and finishes', async () => {
    const root = await profile()
    const p = withoutMigrate(root)
    const order: string[] = []
    p.signInLocal = async (host) => {
      order.push(`login:${host}`)
    }
    const term = terminal()
    const result = await runSetup(p, ['--yes', '--login'], {
      terminal: term,
      home: root,
      env: { PATH: '', OPENCODE_CONFIG_DIR: root },
      fence: {
        async listRunningHosts() {
          return []
        },
      },
    })
    expect(result.hosts).toEqual(['opencode'])
    expect(order).toEqual(['login:opencode'])
    expect(
      parse(await readFile(join(root, 'opencode.jsonc'), 'utf8')).plugin,
    ).toEqual(['@cortexkit/opencode-test-auth@1.2.3'])
    const output = term.lines.join('')
    expect(output).not.toContain('migrat')
    expect(output).toContain('Configured Test Auth for opencode (local).')
  })
})

describe('--host with a separate value', () => {
  test('--host pi and --host opencode select hosts like the = form', async () => {
    for (const [argv, hosts] of [
      [['--host', 'pi'], ['pi']],
      [['--host', 'opencode'], ['opencode']],
      [
        ['--host', 'pi', '--host=opencode'],
        ['opencode', 'pi'],
      ],
    ] as const) {
      const io = fakeIO()
      io.files.set('/bin/opencode', '')
      io.files.set('/bin/pi', '')
      const result = await runSetup(plugin(), ['--yes', '--dry-run', ...argv], {
        ...io,
        terminal: terminal(),
      })
      expect(result.hosts).toEqual([...hosts])
    }
  })

  test('a missing or unknown value after --host refuses before detection', async () => {
    for (const argv of [
      ['--yes', '--dry-run', '--host'],
      ['--yes', '--dry-run', '--host', 'other'],
      ['--yes', '--dry-run', '--host', ''],
      ['--yes', '--dry-run', '--host', 'opencode,pi'],
      ['--host', '--yes', '--dry-run'],
    ]) {
      const io = fakeIO()
      io.files.set('/bin/opencode', '')
      io.files.set('/bin/pi', '')
      const term = terminal()
      await expect(
        runSetup(plugin(), argv, { ...io, terminal: term }),
      ).rejects.toThrow(UNAVAILABLE_HOST)
      expect(io.commands).toEqual([])
      expect(term.lines).toEqual([])
    }
  })

  test('--opencode keeps accepting only the = form', () => {
    expect(() => parseSetupFlags(['--opencode', '2'])).toThrow(
      'Unknown setup argument: --opencode.',
    )
  })
})

describe('setup usage', () => {
  test('setupUsage lists every flag the shared parser accepts', () => {
    const usage = setupUsage()
    expect(SETUP_FLAGS.map((flag) => flag.name).sort()).toEqual(
      [
        '--claustrum',
        '--dry-run',
        '--enroll-only',
        '--host',
        '--login',
        '--no-claustrum',
        '--opencode',
        '--yes',
      ].sort(),
    )
    expect(usage.split('\n')[0]).toBe('Flags:')
    expect(usage.split('\n')).toHaveLength(SETUP_FLAGS.length + 1)
    for (const flag of SETUP_FLAGS) {
      if (!('values' in flag)) {
        expect(usage).toContain(`  ${flag.name} `)
        expect(parseSetupFlags([flag.name])[flag.key]).toBe(true)
        continue
      }
      expect(usage).toContain(
        `  ${flag.name}${flag.spaceForm ? ' ' : '='}${flag.values.join('|')} `,
      )
      for (const value of flag.values) {
        expect(() => parseSetupFlags([`${flag.name}=${value}`])).not.toThrow()
        if (flag.spaceForm)
          expect(() => parseSetupFlags([flag.name, value])).not.toThrow()
      }
    }
    expect(usage).toContain('--host opencode|pi')
    expect(usage).toContain('--opencode=1|2|both')
  })

  test('setupUsage with a command starts with a usage line', () => {
    const usage = setupUsage({ command: 'example-auth setup' })
    expect(
      usage.startsWith('Usage: example-auth setup [flags]\n\nFlags:\n'),
    ).toBe(true)
    expect(usage.endsWith(setupUsage())).toBe(true)
  })

  test('the shared parser refuses --help and points at the plugin help', async () => {
    const io = fakeIO()
    const term = terminal()
    await expect(
      runSetup(plugin(), ['--help'], { ...io, terminal: term }),
    ).rejects.toThrow(
      "Unknown setup argument: --help. Run the plugin's own setup --help to list the flags setup accepts.",
    )
    expect(io.commands).toEqual([])
    expect(term.lines).toEqual([])
  })
})
