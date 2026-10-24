import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const inspector = await readFile('test/windows/inspect.ps1', 'utf8')
const inspectAction = inspector.slice(
  inspector.indexOf("if ($request.action -eq 'inspect')"),
  inspector.indexOf("if ($request.action -eq 'grant')"),
)
const workflow = await readFile(
  '.github/workflows/windows-private-files.yml',
  'utf8',
)
const vaultJob = workflow.slice(
  workflow.indexOf('  vault-enrollment:'),
  workflow.indexOf('  claustrum-hub:'),
)
const warmup = await readFile('test/windows/warm-inspector.mjs', 'utf8')
const vault = await readFile('test/windows/claustrum-vault.mjs', 'utf8')

test('Windows ACL inspection uses .NET without Storage or CIM autoload', () => {
  expect(inspectAction).toContain("$PSModuleAutoLoadingPreference = 'None'")
  expect(inspectAction).toContain(
    '[Security.AccessControl.DirectorySecurity]::new',
  )
  expect(inspectAction).toContain('[Security.AccessControl.FileSecurity]::new')
  expect(inspectAction).toContain('[IO.DriveInfo]::new')
  expect(inspectAction).toContain('.DriveFormat')
  expect(inspectAction).not.toMatch(
    /\b(?:Get-Volume|Get-CimInstance|Get-WmiObject)\b/,
  )
})

test('Windows inspector reports startup, module, type and each ACL phase on stderr', () => {
  const phases = [
    "Progress 'start'",
    "Progress 'module load begin: Microsoft.PowerShell.Utility'",
    'Import-Module Microsoft.PowerShell.Utility',
    "Progress 'module load done: Microsoft.PowerShell.Utility'",
    "Progress 'request read begin'",
    '[Console]::In.ReadToEnd()',
    "Progress 'type load begin: identity, ACL, DriveInfo'",
    "Progress 'type load done: identity, ACL, DriveInfo'",
    'foreach ($path in $request.paths)',
    'Progress "ACL read begin: $path"',
    'Progress "ACL read done: $path"',
    "Progress 'filesystem read begin: DriveInfo.DriveFormat'",
    "Progress 'filesystem read done: DriveInfo.DriveFormat'",
    "Progress 'inspect done'",
  ].map((phase) => inspector.indexOf(phase))
  expect(phases.every((index) => index >= 0)).toBe(true)
  expect(phases).toEqual([...phases].sort((a, b) => a - b))
  expect(inspector).toContain('[Console]::Error.WriteLine(')
  expect(inspector).toContain('[Console]::Error.Flush()')
  expect(inspector).toContain('$clock.ElapsedMilliseconds')
  expect(vault).toContain('PowerShell has not reported start')
})

test('Windows vault job warms the inspector once before tests with bounded fresh-process samples', () => {
  const command = 'node test/windows/warm-inspector.mjs'
  expect(
    vaultJob.match(/node test\/windows\/warm-inspector\.mjs/g),
  ).toHaveLength(1)
  expect(vaultJob.indexOf(command)).toBeLessThan(
    vaultJob.indexOf('- name: Real profile vault enrollment'),
  )
  expect(vaultJob).toContain('timeout-minutes: 3')
  expect(vaultJob).toContain('windows-vault-evidence/inspector-warmup.log')
  expect(warmup).toContain('sample < 4')
  expect(warmup).toContain('sample === 0 ? 60_000 : 30_000')
  expect(warmup).toContain('spawnSync(')
  expect(warmup).toContain('timeout,')
  expect(warmup).toContain("event: 'inspector-timing'")
  expect(warmup).toContain('elapsedMs,')
  expect(warmup).toContain('assert.ifError(result.error)')
  expect(vault).toContain('const timeout = 30_000')
  expect(vault).toContain('}, timeout)')
  expect(vault).not.toContain('warm-inspector.mjs')
})
