import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

function inspectAcls(paths) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('../windows/inspect.ps1', import.meta.url)),
    ],
    {
      input: JSON.stringify({ action: 'inspect', paths }),
      env,
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  assert.equal(result.status, 0, `ACL inspector failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

function verifyInheritedConfigAcls(folder) {
  const reference = join(folder, 'ordinary-acl-reference.json')
  // A child created independently of setup records the folder's ordinary file inheritance.
  writeFileSync(reference, '{}', { flag: 'wx' })
  try {
    const { objects } = inspectAcls([
      folder,
      reference,
      config,
      join(folder, 'tui.jsonc'),
    ])
    const expected = objects[1]
    assert.equal(
      expected.control & 0x1000,
      0,
      'ordinary reference has no protected DACL',
    )
    const normalized = (aces) =>
      aces
        .map((ace) => JSON.stringify([ace.type, ace.flags, ace.mask, ace.sid]))
        .sort()
    for (const actual of objects.slice(2)) {
      assert.equal(
        actual.control & 0x1000,
        0,
        `${actual.path} has no protected DACL`,
      )
      assert.ok(
        actual.aces.length > 0 &&
          actual.aces.every((ace) => (ace.flags & 0x10) !== 0),
        `${actual.path} inherits all ACL entries`,
      )
      assert.deepEqual(
        normalized(actual.aces),
        normalized(expected.aces),
        `${actual.path} matches its folder's file-inheritance policy`,
      )
    }
    console.log('7 inherited config ACL checks passed')
  } finally {
    rmSync(reference, { force: true })
  }
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
  const beforeSecond = readFileSync(config, 'utf8')
  const statBeforeSecond = statSync(config, { bigint: true })
  run(['--yes'])
  check(
    readFileSync(config, 'utf8') === beforeSecond,
    'second run preserves config bytes',
  )
  const statAfterSecond = statSync(config, { bigint: true })
  check(
    statAfterSecond.mtimeNs === statBeforeSecond.mtimeNs &&
      statAfterSecond.ino === statBeforeSecond.ino,
    'second run does not rewrite the config',
  )
  const value = parse(readFileSync(config, 'utf8'))
  assert.deepEqual(value.plugin, ['@cortexkit/opencode-setup-fixture@1.0.0'])
  checks++
  check(
    !value.plugins?.length,
    'plugin is not registered a second time under plugins',
  )
  if (process.platform === 'win32') {
    verifyInheritedConfigAcls(join(root, '.config', 'opencode'))
    checks++
  }
  console.log(
    `${process.version} ${process.platform}/${process.arch}: ${checks} setup checks passed`,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
