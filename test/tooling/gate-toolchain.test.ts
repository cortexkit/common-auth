import { describe, expect, test } from 'bun:test'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

function fakeBun(variable: string) {
  return `#!/bin/sh
if [ "$1" = --version ]; then
  [ "$${variable}" != unavailable ] || exit 127
  printf '%s\\n' "$${variable}"
  exit 0
fi
# Stop at the first dependency command so these probes never run the full gate.
printf 'SELECTED_BUN=%s ARGS=%s\\n' "$${variable}" "$*" >&2
exit 97
`
}

async function runGate({
  hostBun = '1.4.2',
  installedBun = '1.4.4',
  npmFails = false,
  node = 'v24.0.0',
  fast = false,
} = {}) {
  const scratch = join(root, 'target/scratch')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'gate-toolchain-'))
  try {
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await mkdir(join(directory, 'scripts'))
    await copyFile(
      join(root, 'scripts/gate.sh'),
      join(directory, 'scripts/gate.sh'),
    )
    const commands = {
      bun: fakeBun('GATE_TEST_HOST_BUN'),
      node: '#!/bin/sh\nprintf "%s\\n" "$GATE_TEST_NODE"\n',
      uname: '#!/bin/sh\necho Linux\n',
      npm: `#!/bin/sh
printf '%s\\n' "$*" > "$GATE_TEST_ROOT/npm.calls"
if [ "$GATE_TEST_NPM_FAIL" = 1 ]; then
  echo 'registry unavailable' >&2
  exit 1
fi
[ "$1" = install ] && [ "$2" = --prefix ] && [ "$4" = bun@1.4.4 ] || exit 2
mkdir -p "$3/node_modules/.bin" || exit 1
cp "$GATE_TEST_ROOT/installed-bun" "$3/node_modules/.bin/bun"
`,
    }
    for (const [name, content] of Object.entries(commands)) {
      await writeFile(join(bin, name), content, { mode: 0o755 })
    }
    await writeFile(
      join(directory, 'installed-bun'),
      fakeBun('GATE_TEST_INSTALLED_BUN'),
      { mode: 0o755 },
    )
    const result = Bun.spawnSync(
      ['bash', join(directory, 'scripts/gate.sh'), ...(fast ? ['--fast'] : [])],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GATE_TEST_ROOT: directory,
          GATE_TEST_HOST_BUN: hostBun,
          GATE_TEST_INSTALLED_BUN: installedBun,
          GATE_TEST_NPM_FAIL: npmFails ? '1' : '0',
          GATE_TEST_NODE: node,
        },
      },
    )
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      npmCalls: await readFile(join(directory, 'npm.calls'), 'utf8').catch(
        () => '',
      ),
      tools: join(directory, 'target/scratch/gate-tools'),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// The Bash gate supports Linux and macOS; Windows runs separate CI recipes.
describe.skipIf(process.platform === 'win32')('gate toolchain', () => {
  test('full gate fetches and selects the exact pin when host Bun differs', async () => {
    const result = await runGate()
    expect(result.exitCode).toBe(1)
    expect(result.npmCalls).toBe(
      `install --prefix ${result.tools} bun@1.4.4 --no-audit --no-fund\n`,
    )
    expect(result.output).toContain(
      `Using Bun 1.4.4 (${result.tools}/node_modules/.bin/bun)`,
    )
    expect(result.output).toContain('PART toolchain pass=1 fail=0')
    expect(result.output).toContain(
      'SELECTED_BUN=1.4.4 ARGS=install --frozen-lockfile',
    )
    expect(result.output).toContain('GATE_FAILED frozen-lockfile')
  })

  test('full gate obtains Bun when the host executable is unusable', async () => {
    const result = await runGate({ hostBun: 'unavailable' })
    expect(result.npmCalls).toContain('bun@1.4.4')
    expect(result.output).toContain(
      'Bun on PATH is unavailable; fetching Bun 1.4.4',
    )
    expect(result.output).toContain('PART toolchain pass=1 fail=0')
  })

  test('full gate keeps a matching host Bun without fetching', async () => {
    const result = await runGate({ hostBun: '1.4.4' })
    expect(result.npmCalls).toBe('')
    expect(result.output).toContain('PART toolchain pass=1 fail=0')
    expect(result.output).toContain('SELECTED_BUN=1.4.4')
  })

  test('full gate refuses a failed Bun fetch with diagnostics', async () => {
    const result = await runGate({ npmFails: true })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('registry unavailable')
    expect(result.output).toContain('Cannot obtain required Bun 1.4.4')
    expect(result.output).toContain('GATE_FAILED toolchain')
    expect(result.output).not.toContain('== frozen-lockfile ==')
  })

  test('full gate rejects an installed Bun that does not match the pin', async () => {
    const result = await runGate({ installedBun: '1.4.2' })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain(
      'Required Bun 1.4.4, but selected Bun reports 1.4.2',
    )
    expect(result.output).toContain('GATE_FAILED toolchain')
    expect(result.output).not.toContain('== frozen-lockfile ==')
  })

  test('full gate still requires Node 24 before fetching Bun', async () => {
    const result = await runGate({ node: 'v22.0.0' })
    expect(result.exitCode).toBe(1)
    expect(result.npmCalls).toBe('')
    expect(result.output).toContain('Full gate requires Linux and Node 24')
    expect(result.output).toContain('GATE_FAILED toolchain')
  })

  test('fast gate rejects a mismatching local Bun without fetching', async () => {
    const result = await runGate({ fast: true })
    expect(result.exitCode).toBe(1)
    expect(result.npmCalls).toBe('')
    expect(result.output).toContain(
      'Use Bun 1.4.4, the newest CI matrix entry.',
    )
    expect(result.output).toContain('GATE_FAILED toolchain')
  })

  test('fast gate keeps a matching local Bun and accepts other Node versions', async () => {
    const result = await runGate({
      fast: true,
      hostBun: '1.4.4',
      node: 'v22.0.0',
    })
    expect(result.npmCalls).toBe('')
    expect(result.output).toContain('PART toolchain pass=1 fail=0')
    expect(result.output).toContain('SELECTED_BUN=1.4.4')
  })
})
