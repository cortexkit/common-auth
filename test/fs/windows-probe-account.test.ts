import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const workflow = await readFile(
  '.github/workflows/windows-private-files.yml',
  'utf8',
)
const inspector = await readFile('test/windows/inspect.ps1', 'utf8')
const provision = await readFile('test/windows/provision-user.ps1', 'utf8')
const cleanup = await readFile('test/windows/cleanup-user.ps1', 'utf8')
const probe = await readFile('test/windows/second-user.ps1', 'utf8')
const harness = await readFile('test/windows/common-auth.mjs', 'utf8')
const steps = workflow.split(/\n(?= {6}- )/)
const step = (id: string) =>
  steps.find((text) => text.includes(`id: ${id}\n`)) ?? ''

test('Windows denial probes reuse one warmed job account without increasing probe budgets', () => {
  expect(workflow.match(/id: probe_account/g)).toHaveLength(1)
  expect(workflow.indexOf('id: probe_account')).toBeLessThan(
    workflow.indexOf('id: node_acl'),
  )
  expect(step('probe_account')).toContain('timeout-minutes: 4')
  expect(provision).toContain('-LoadUserProfile')
  expect(provision).toContain('WaitForExit(150000)')
  expect(provision).toContain('warmMs=')
  expect(inspector).not.toMatch(/New-LocalUser|Remove-LocalUser/)
  expect(inspector).toContain('$env:COMMON_AUTH_PROBE_USER')
  expect(inspector).toContain('$env:COMMON_AUTH_PROBE_SID')
  expect(inspector).toContain('WaitForExit(30000)')
  expect(harness).toContain('const timeout = 45_000')
  expect(probe).toContain("throw 'Public read positive control failed'")
  expect(probe.indexOf('Public read positive control failed')).toBeLessThan(
    probe.indexOf('foreach ($path'),
  )
})

test('Windows probe credentials are masked and cleanup is mandatory even after setup failure', () => {
  const mask = provision.indexOf('::add-mask::$plain')
  expect(mask).toBeGreaterThan(0)
  expect(mask).toBeLessThan(
    provision.indexOf('[IO.File]::AppendAllText($env:GITHUB_OUTPUT'),
  )
  expect(provision.indexOf('user=$name')).toBeGreaterThan(
    provision.indexOf('New-LocalUser'),
  )
  expect(provision.indexOf('user=$name')).toBeLessThan(
    provision.indexOf('Add-LocalGroupMember'),
  )
  for (const id of [
    'node_acl',
    'bun142_acl',
    'bun142_mutations',
    'bun1314_acl',
    'bun1314_mutations',
  ]) {
    expect(step(id)).toContain(
      `COMMON_AUTH_PROBE_PASSWORD: \${{ steps.probe_account.outputs.password }}`,
    )
    expect(step(id)).toContain(
      `COMMON_AUTH_PROBE_USER: \${{ steps.probe_account.outputs.user }}`,
    )
    expect(step(id)).toContain(
      `COMMON_AUTH_PROBE_SID: \${{ steps.probe_account.outputs.sid }}`,
    )
  }
  expect(step('probe_cleanup')).toContain('if: always()')
  expect(step('probe_cleanup')).toContain('timeout-minutes: 2')
  expect(step('probe_cleanup')).not.toContain('outputs.password')
  expect(cleanup).toContain('Remove-LocalUser -Name $Name')
  expect(workflow).toContain("$checks = @('PROBE_SETUP','PROBE_CLEANUP'")
})
