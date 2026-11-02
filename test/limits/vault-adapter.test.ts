import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { VaultInventory } from '../../src/claustrum/custody.js'
import {
  mutateVaultRoster,
  projectVaultRoster,
  readVaultRoster,
} from '../../src/claustrum/roster.js'
import type {
  LimitsCommand,
  LimitsPersistenceSnapshot,
} from '../../src/limits/index.js'
import { createVaultLimitsAdapter } from '../../src/limits/vault.js'
import { runChild } from '../store/helpers.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

function inventory(
  view: string,
  records: [string, string | undefined][],
): VaultInventory {
  return {
    view,
    skipped: [],
    credentials: records.map(([credentialId, accountIdentity]) => ({
      credentialId,
      credentialType: 'oauth',
      state: 'active',
      ...(accountIdentity === undefined ? {} : { accountIdentity }),
    })),
  }
}

async function fixture(unknown = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vault-limits-'))
  directories.push(directory)
  const path = join(directory, 'roster.json')
  const namespace = `vault:${path}`
  const list = inventory('initial', [['a', unknown ? undefined : 'account-a']])
  const roster = projectVaultRoster(undefined, list, { now: 10 })
  await mutateVaultRoster(path, () => ({ next: roster, result: undefined }))
  const adapter = await createVaultLimitsAdapter({
    namespace,
    path,
    now: () => 100,
  })
  return { directory, path, namespace, list, roster, adapter }
}

function mark(
  view: LimitsPersistenceSnapshot,
  operationId = 'mark',
): Extract<LimitsCommand, { type: 'mark' }> {
  return {
    type: 'mark',
    producerId: 'test',
    operationId,
    binding: view.bindings[0]!,
    baseRevision: view.snapshot.revision,
    scope: { kind: 'pool' },
    window: 'requests',
    until: 10_000,
    evidenceAt: 100,
    mergeLaw: 'overwrite',
  }
}

for (const change of [
  'remove',
  'remove-readd',
  'known-identity',
  'alias',
  'representative',
  'bind',
] as const) {
  test(`validates vault binding after another process commits ${change}, without a reload`, async () => {
    const { path, adapter, list, roster } = await fixture(change === 'bind')
    const observed = await adapter.read()
    const command = mark(observed)
    const discoveries =
      change === 'remove'
        ? [{ inventory: inventory('empty', []), now: 20 }]
        : change === 'remove-readd'
          ? [
              { inventory: inventory('empty', []), now: 20 },
              { inventory: list, now: 30 },
            ]
          : change === 'alias'
            ? [
                {
                  inventory: inventory('alias', [
                    ['a', 'account-a'],
                    ['b', 'account-a'],
                  ]),
                  now: 20,
                },
              ]
            : change === 'representative'
              ? [
                  {
                    inventory: inventory('representative', [
                      ['b', 'account-a'],
                    ]),
                    now: 20,
                  },
                ]
              : change === 'bind'
                ? [
                    {
                      inventory: inventory('bound', [['a', 'account-a']]),
                      now: 20,
                    },
                  ]
                : []
    const child = runChild({
      op: 'vault-roster',
      path,
      discoveries,
      ...(change === 'known-identity' && { knownIdentity: 'account-other' }),
    })
    expect(await child.exited, child.output()).toBe(0)
    const changed = await readVaultRoster(path)
    if (change === 'remove-readd') {
      expect(changed?.rows[0]?.routeId).toBe(roster.rows[0]!.routeId)
      expect(changed?.rows[0]?.addedAt).toBe(30)
    }
    if (change === 'representative')
      expect(changed?.rows[0]?.credentialId).toBe('b')
    if (change === 'alias') expect(changed?.rows[0]?.aliases).toEqual(['b'])
    if (change === 'bind')
      expect(changed?.rows[0]?.accountIdentity).toBe('account-a')
    const committed = await adapter.commit([command])
    const rejected = ['remove', 'remove-readd', 'known-identity'].includes(
      change,
    )
    expect(committed.outcomes[0]).toMatchObject({
      status: rejected ? 'rejected' : 'committed',
    })
    expect(committed.snapshot.marks).toHaveLength(rejected ? 0 : 1)
    if (!rejected)
      expect(committed.bindings[0]?.account).toEqual(command.binding.account)
    expect((await adapter.read()).snapshot).toEqual(committed.snapshot)
  })
}

test('commits merge durable limits and preserve unrelated roster fields', async () => {
  const { path, adapter, namespace, roster } = await fixture()
  const second = await createVaultLimitsAdapter({
    namespace,
    path,
    now: () => 100,
  })
  const observed = await adapter.read()
  const other = await second.commit([mark(observed, 'other')])
  const committed = await adapter.commit([
    { ...mark(observed), window: 'tokens' },
  ])
  expect(committed.snapshot.revision).toBeGreaterThan(other.snapshot.revision)
  expect(
    committed.snapshot.marks.map((entry) => entry.key.window).sort(),
  ).toEqual(['requests', 'tokens'])
  const { limits, ...rest } = (await readVaultRoster(path))!
  expect(limits).toEqual(committed.snapshot)
  expect(rest).toEqual(roster)
})

test('rejects an unsupported envelope schema without dropping it on roster reads', async () => {
  const { path, namespace } = await fixture()
  const limits = { schemaVersion: 2, future: ['keep'] }
  await mutateVaultRoster(path, (current) => ({
    next: { ...current!, limits },
    result: undefined,
  }))
  expect((await readVaultRoster(path))?.limits).toEqual(limits)
  await expect(createVaultLimitsAdapter({ namespace, path })).rejects.toThrow(
    'Invalid or unsupported',
  )
  expect((await readVaultRoster(path))?.limits).toEqual(limits)
})

test('vault namespace makes zero local-account-store file accesses during hydrate, reader reload and writes', async () => {
  const { path, namespace, directory } = await fixture()
  const adapterUrl = new URL('../../src/limits/vault.ts', import.meta.url).href
  const registryUrl = new URL('../../src/limits/registry.ts', import.meta.url)
    .href
  const code = `
    import { mock } from 'bun:test'
    import { fileURLToPath } from 'node:url'
    const asyncFs = await import('node:fs/promises')
    const syncFs = await import('node:fs')
    const paths = []
    const names = new Set(['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'exists', 'lstat', 'mkdir', 'mkdtemp', 'open', 'readFile', 'readdir', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'])
    function wrap(module) {
      return Object.fromEntries(Object.entries(module).map(([name, value]) => [name,
        typeof value === 'function' && names.has(name.replace(/Sync$/, '')) ? (...args) => {
          for (const index of name.startsWith('rename') || name.startsWith('copyFile') ? [0, 1] : [0]) {
            if (typeof args[index] === 'string') paths.push(args[index])
            else if (args[index] instanceof URL) paths.push(fileURLToPath(args[index]))
          }
          return value(...args)
        } : value
      ]))
    }
    const wrappedAsync = wrap(asyncFs)
    mock.module('node:fs/promises', () => ({ ...wrappedAsync, default: wrappedAsync }))
    const wrappedSync = { ...wrap(syncFs), promises: wrappedAsync }
    mock.module('node:fs', () => ({ ...wrappedSync, default: wrappedSync }))
    const { createVaultLimitsAdapter } = await import(${JSON.stringify(adapterUrl)})
    const { acquireLimitsRegistry } = await import(${JSON.stringify(registryUrl)})
    let now = 100
    let id = 0
    const timers = new Map()
    const clock = {
      now: () => now,
      setTimeout: (callback, delay) => { const key = ++id; timers.set(key, { callback, at: now + delay }); return key },
      clearTimeout: (key) => timers.delete(key),
    }
    const adapter = await createVaultLimitsAdapter({ path: ${JSON.stringify(path)}, namespace: ${JSON.stringify(namespace)}, now: () => now })
    let reads = 0
    const counted = { ...adapter, read: (...args) => { reads++; return adapter.read(...args) } }
    const registry = await acquireLimitsRegistry({ adapter: counted, clock, isAccessRestrictive: () => false })
    try {
      const binding = (await adapter.read()).bindings[0]
      const observed = registry.observe(binding)
      registry.enqueue({ ...observed, type: 'mark', producerId: 'io', operationId: 'mark', scope: { kind: 'pool' }, window: 'requests', until: 10000, evidenceAt: now, mergeLaw: 'overwrite' })
      await registry.flush()
      now = 1100
      for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback() }
      await registry.beforeDispatch(binding)
      console.log(JSON.stringify({ paths, reads, marks: registry.snapshot.marks.length }))
    } finally { await registry.dispose() }
  `
  const child = Bun.spawn([process.execPath, '--eval', code], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: directory, USERPROFILE: directory },
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stderr).toBe(0)
  const result = JSON.parse(stdout) as {
    paths: string[]
    reads: number
    marks: number
  }
  expect(result.reads).toBeGreaterThanOrEqual(2)
  expect(result.marks).toBe(1)
  expect(result.paths.length).toBeGreaterThan(0)
  expect(
    result.paths.filter((access) => {
      const path = relative(directory, access)
      return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
    }),
  ).toEqual([])
})

test('published limits/vault entry loads without optional peers or the local account store', async () => {
  const { directory } = await fixture()
  const pkg = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  expect(pkg.exports['./limits/vault']).toEqual({
    types: './dist/limits/vault.d.ts',
    import: './dist/limits/vault.js',
  })
  expect(
    await readFile(
      new URL(`../../${pkg.exports['./limits/vault'].types}`, import.meta.url),
      'utf8',
    ),
  ).toContain('createVaultLimitsAdapter')
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL(
          `../../${pkg.exports['./limits/vault'].import}`,
          import.meta.url,
        ),
      ),
    ],
    target: 'bun',
    format: 'esm',
    external: ['@cortexkit/private-files'],
    plugins: [
      {
        name: 'no-optional-peers-or-pool',
        setup(build) {
          build.onResolve(
            {
              filter:
                /@cortexkit\/(claustrum-client|subc-client)|(^|\/)store\//,
            },
            ({ path }) => {
              throw new Error(`Unexpected vault dependency: ${path}`)
            },
          )
        },
      },
    ],
  })
  expect(built.success, built.logs.map(String).join('\n')).toBe(true)
  const entry = join(directory, 'vault.mjs')
  await writeFile(entry, await built.outputs[0]!.text())
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `const { createVaultLimitsAdapter } = await import(${JSON.stringify(pathToFileURL(entry).href)}); if (typeof createVaultLimitsAdapter !== 'function') process.exit(1); console.log('vault loaded')`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exit, stderr).toBe(0)
  expect(stdout.trim()).toBe('vault loaded')
  const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(
    await readFile(
      new URL('../../src/limits/vault-adapter.ts', import.meta.url),
      'utf8',
    ),
  )
  expect(imports.map((item) => item.path)).toContain('../claustrum/roster.js')
})
