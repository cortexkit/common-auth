#!/usr/bin/env node
// This fixture exercises the published setup subpath without a provider login.
import { join } from 'node:path'
import { runSetup } from '@cortexkit/common-auth/setup'

const home =
  process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME
const stateDir = join(home, 'fixture-state')
try {
  await runSetup(
    {
      packages: {
        opencode: '@cortexkit/opencode-setup-fixture',
        pi: '@cortexkit/pi-setup-fixture',
      },
      version: '1.0.0',
      displayName: 'Setup fixture',
      slashCommand: '/fixture',
      vault: {
        connectionFile: join(stateDir, 'absent-connection.json'),
        hosts: {
          opencode: {
            name: 'fixture-opencode',
            paths: { stateDir, host: 'opencode' },
          },
          pi: { name: 'fixture-pi', paths: { stateDir, host: 'pi' } },
        },
      },
      async signInLocal() {},
      async migrate() {},
    },
    process.argv.slice(2),
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
