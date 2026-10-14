import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findExecutableOnPath } from '@cortexkit/common-auth/setup'
import { parse } from 'jsonc-parser'

const root = mkdtempSync(join(tmpdir(), 'common-auth-npm-setup-'))
const config = join(root, '.config', 'opencode', 'opencode.jsonc')
const bin = fileURLToPath(new URL('./setup-bin.mjs', import.meta.url))
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  OPENCODE_CONFIG_DIR: '',
  OPENCODE_CONFIG: '',
  OPENCODE_CONFIG_CONTENT: '',
  XDG_CONFIG_HOME: '',
  XDG_DATA_HOME: '',
  XDG_STATE_HOME: '',
  PI_CODING_AGENT_DIR: join(root, 'absent-pi'),
}
let checks = 0
function check(condition, message) {
  assert.ok(condition, message)
  checks++
}
function run(args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.equal(
    result.status,
    0,
    `${args.join(' ')} failed: ${result.error ?? result.stderr}`,
  )
  checks++
  return result.stdout
}
try {
  const executable = findExecutableOnPath('opencode', { env })
  check(executable, 'npm OpenCode is on PATH')
  if (process.platform === 'win32')
    check(
      executable.endsWith('.cmd'),
      'Windows npm launcher is opencode.cmd, not a POSIX shim',
    )
  const dry = run(['--yes', '--dry-run'])
  check(dry.includes('OpenCode: found'), 'dry run detects npm OpenCode')
  check(
    dry.includes(`Would write ${config}`),
    'dry run plans the cross-platform ~/.config/opencode path',
  )
  check(!existsSync(config), 'dry run creates no config')
  run(['--yes'])
  run(['--yes'])
  const value = parse(readFileSync(config, 'utf8'))
  assert.deepEqual(value.plugin, ['@cortexkit/opencode-setup-fixture@1.0.0'])
  checks++
  check(
    !value.plugins?.length,
    'plugin is not registered a second time under plugins',
  )
  console.log(
    `${process.version} ${process.platform}/${process.arch}: ${checks} setup checks passed`,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
