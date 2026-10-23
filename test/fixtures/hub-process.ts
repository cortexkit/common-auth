// One discovery hub in a process of its own, for the hub's two-process test.
// It lists a fake vault kept in a JSON file the test rewrites, and answers one
// command per stdin line with one JSON line on stdout:
//   refresh  list once and commit every member; replies with alpha's roster
//   hold     alpha's next commit stops inside its roster write lock, replies
//            "holding", and goes on once the file at `goPath` exists
//   exit     close the hub and exit
import { existsSync, readFileSync, writeSync } from 'node:fs'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import {
  type ClassifyingClaustrumFamily,
  ClaustrumDiscoveryHub,
} from '../../src/claustrum/index.ts'

const [stateDir, tokenPath, vaultPath, classifierVersion, goPath] =
  process.argv.slice(2)
if (!stateDir || !tokenPath || !vaultPath || !classifierVersion || !goPath)
  throw new Error(
    'usage: hub-process <stateDir> <tokenPath> <vaultPath> <version> <goPath>',
  )

const MEMBERS = ['alpha', 'beta', 'gamma']
// The same classification as hub.test.ts's family.
const family: ClassifyingClaustrumFamily<'reserved-provider'> = {
  category: 'llm-provider',
  refusalCodes: ['reserved-provider'],
  classify: (facts) => {
    const provider = facts.providerIds?.[0]
    if (provider === 'openai')
      return { kind: 'refused', code: 'reserved-provider' }
    return provider && MEMBERS.includes(provider)
      ? { kind: 'mine', member: provider }
      : { kind: 'not-mine' }
  },
}

/** Write one reply line at once, even while the event loop is held below. */
function reply(value: unknown): void {
  writeSync(1, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
}

let hold = false
const hub = new ClaustrumDiscoveryHub({
  stateDir,
  hostGeneration: 'opencode2',
  // The test's classifier input, with the version this process was given.
  classifierInput: {
    classifier: 'hub-test',
    version: Number(classifierVersion),
    providers: [{ id: 'alpha', integration: 'openai-compatible' }],
  },
  members: MEMBERS,
  tokenPath,
  family,
  connect: async () => ({
    listScoped: async () => {
      const vault = JSON.parse(readFileSync(vaultPath, 'utf8')) as {
        view: string
        rows: ScopedInventoryRow[]
      }
      return { ...vault, grants: undefined, grantTuples: undefined }
    },
    getScoped: async () => {
      throw new Error('this process never serves')
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }),
  pollIntervalMs: 0,
})
const alpha = hub.member('alpha', {
  // Called while alpha's commit holds its roster write lock, just before it
  // projects. Holding the whole process here keeps that lock held, as a slow
  // commit in another process would, until the test says to go on.
  reservedRouteIds: () => {
    if (hold) {
      hold = false
      reply('holding')
      while (!existsSync(goPath)) Bun.sleepSync(5)
    }
    return []
  },
})
for (const provider of MEMBERS.slice(1)) hub.member(provider, {})

for await (const line of console) {
  const command = line.trim()
  if (command === 'hold') hold = true
  else if (command === 'refresh') {
    await hub.refresh()
    const roster = alpha.snapshot()
    reply({
      path: hub.rosterPath('alpha'),
      view: roster?.view,
      rows: roster?.rows.map((row) => [row.credentialId, row.enabled]),
    })
  } else if (command === 'exit') break
}
hub.close()
process.exit(0)
