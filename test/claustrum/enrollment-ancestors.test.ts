import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readClaustrumEnrollmentToken,
  refuseWritableAncestor,
} from '../../src/claustrum/enrollment.ts'
import {
  ClaustrumEnrollmentManager,
  ClaustrumScopedCustody,
  getClaustrumEnrollmentPaths,
} from '../../src/claustrum/index.ts'

import { family } from './helpers.ts'

const dirs: string[] = []
const uid = process.geteuid?.() ?? 0
const gid = process.getegid?.() ?? 0
const posixTest = test.skipIf(process.geteuid === undefined)

async function fixture(
  passwd = `tester:x:${uid}:${gid}::/:/bin/sh\n`,
  group = `tester:x:${gid}:\n`,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'enrollment-ancestors-')),
  )
  dirs.push(root)
  const parent = join(root, 'group-writable')
  await mkdir(parent)
  await chmod(parent, 0o775)
  const passwdPath = join(root, 'passwd')
  const groupPath = join(root, 'group')
  await writeFile(passwdPath, passwd)
  await writeFile(groupPath, group)
  return { root, parent, options: { passwdPath, groupPath } }
}

async function refuses(f: Awaited<ReturnType<typeof fixture>>) {
  await expect(refuseWritableAncestor(f.parent, f.options)).rejects.toThrow(
    `Claustrum enrollment path has a writable ancestor: ${f.parent}. Another user could replace it. Run: chmod g-w,o-w ${f.parent}`,
  )
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

posixTest(
  'accepts a group-writable ancestor owned by the effective user and private group',
  async () => {
    const f = await fixture(
      `# comment\n\ntester:x:${uid}:${gid}::/:/bin/sh\n`,
      `# comment\n\ntester:x:${gid}:tester\n`,
    )
    await refuseWritableAncestor(f.parent, f.options)
  },
)
posixTest(
  'refuses a group-writable ancestor with another explicit group member',
  async () => {
    await refuses(await fixture(undefined, `tester:x:${gid}:tester,other\n`))
  },
)
posixTest(
  'refuses a group-writable ancestor with another primary-gid user',
  async () => {
    await refuses(
      await fixture(
        `tester:x:${uid}:${gid}::/:/bin/sh\nother:x:${uid + 1}:${gid}::/:/bin/sh\n`,
      ),
    )
  },
)
posixTest(
  'refuses a group-writable ancestor when its gid is absent',
  async () => {
    await refuses(await fixture(undefined, `other:x:${gid + 1}:\n`))
  },
)
posixTest(
  'refuses a group-writable ancestor when account files are unreadable',
  async () => {
    for (const key of ['passwdPath', 'groupPath'] as const) {
      const f = await fixture()
      f.options[key] = join(f.root, 'missing')
      await refuses(f)
    }
  },
)
posixTest(
  'refuses a group-writable ancestor owned by another uid',
  async () => {
    const f = await fixture(`tester:x:${uid + 1}:${gid}::/:/bin/sh\n`)
    const mock = spyOn(process, 'geteuid').mockReturnValue(uid + 1)
    try {
      await refuses(f)
    } finally {
      mock.mockRestore()
    }
  },
)
posixTest('refuses a group-writable ancestor with another gid', async () => {
  const f = await fixture(
    `tester:x:${uid}:${gid + 1}::/:/bin/sh\n`,
    `tester:x:${gid + 1}:\n`,
  )
  const mock = spyOn(process, 'getegid').mockReturnValue(gid + 1)
  try {
    await refuses(f)
  } finally {
    mock.mockRestore()
  }
})
posixTest(
  'refuses a world-writable ancestor even with a private group',
  async () => {
    const f = await fixture()
    await chmod(f.parent, 0o777)
    await refuses(f)
  },
)
posixTest('accepts a sticky world-writable ancestor', async () => {
  const f = await fixture()
  await chmod(f.parent, 0o1777)
  await refuseWritableAncestor(f.parent, f.options)
})
posixTest(
  'refuses a group-writable ancestor when its uid is absent',
  async () => {
    await refuses(await fixture(`other:x:${uid + 1}:${gid + 1}::/:/bin/sh\n`))
  },
)
posixTest(
  'refuses malformed account records rather than assuming a private group',
  async () => {
    for (const [passwd, group] of [
      [`tester:x:${uid}:${gid}::/:/bin/sh\ninvalid`, `tester:x:${gid}:\n`],
      [`tester:x:${uid}:${gid}::/:/bin/sh\n`, `tester:x:${gid}:\ninvalid`],
    ])
      await refuses(await fixture(passwd, group))
  },
)
posixTest(
  'authorizes with an owner-only token below a non-private writable ancestor',
  async () => {
    const f = await fixture(undefined, `tester:x:${gid}:other\n`)
    const tokenPath = join(f.parent, 'token.json')
    await writeFile(
      tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    await chmod(f.parent, 0o777)
    const custody = new ClaustrumScopedCustody({
      tokenPath,
      family,
      client: {
        listScoped: async () => ({ rows: [], view: 'view-1' }),
        getScoped: async () => ({
          credentialId: 'oauth:test:work',
          accountId: 'account-1',
          material: 'test-access',
          recordVersion: 7,
          expiresAtMs: 1_000_000,
        }),
        reportAuthFailureScoped: async () => {},
        close: () => {},
      },
      now: () => 1_000,
    })
    expect(
      (
        await custody.authorize({
          credentialId: 'oauth:test:work',
          credentialType: 'oauth',
          accountIdentity: 'account-1',
        })
      ).accessToken,
    ).toBe('test-access')
    await chmod(f.parent, 0o775)
    expect(
      (
        await custody.authorize({
          credentialId: 'oauth:test:work',
          credentialType: 'oauth',
          accountIdentity: 'account-1',
        })
      ).accessToken,
    ).toBe('test-access')
  },
)
posixTest(
  'refuses a foreign-owned token even below a writable ancestor',
  async () => {
    const f = await fixture()
    const tokenPath = join(f.parent, 'token.json')
    await writeFile(
      tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    const mock = spyOn(process, 'geteuid').mockReturnValue(uid + 1)
    try {
      await expect(readClaustrumEnrollmentToken(tokenPath)).rejects.toThrow(
        'owned by the current user',
      )
    } finally {
      mock.mockRestore()
    }
  },
)
posixTest(
  'refuses a group-readable token even below a writable ancestor',
  async () => {
    const f = await fixture()
    const tokenPath = join(f.parent, 'token.json')
    await writeFile(
      tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    await chmod(tokenPath, 0o640)
    await expect(readClaustrumEnrollmentToken(tokenPath)).rejects.toThrow(
      'owner-only',
    )
  },
)

// Enable when claustrum-client's writeEnrollmentTokenFile accepts group-writable
// ancestors owned by the caller's private group. It currently refuses those
// ancestors, so this test cannot save the approved Connect token after the
// pending enrollment state has been written.
test.todo('persists an approved Connect token below a private group-writable ancestor', async () => {
  const f = await fixture()
  const paths = getClaustrumEnrollmentPaths(
    join(f.parent, 'private', 'enrollment.json'),
  )
  const manager = new ClaustrumEnrollmentManager({
    paths,
    ancestorOptions: f.options,
    proposedName: 'test-auth-opencode',
    mintSecret: () => '01'.repeat(32),
    client: {
      enrollPropose: async () => ({ requestId: 'request-1' }),
      enrollPoll: async () => ({
        status: 'approved',
        name: 'test-auth-opencode',
        token: '02'.repeat(32),
        tokenGeneration: 1,
      }),
    },
  })
  expect((await manager.reconcile()).state).toBe('approved')
  expect((await readClaustrumEnrollmentToken(paths.tokenPath)).token).toBe(
    '02'.repeat(32),
  )
})

posixTest(
  'persists a pending Connect secret below a private group-writable ancestor',
  async () => {
    const f = await fixture()
    const paths = getClaustrumEnrollmentPaths(
      join(f.parent, 'private', 'enrollment.json'),
    )
    const manager = new ClaustrumEnrollmentManager({
      paths,
      ancestorOptions: f.options,
      proposedName: 'test-auth-opencode',
      client: {
        enrollPropose: async () => ({ requestId: 'request-1' }),
        enrollPoll: async () => ({ status: 'pending' }),
      },
    })
    expect((await manager.reconcile()).state).toBe('pending')
  },
)
