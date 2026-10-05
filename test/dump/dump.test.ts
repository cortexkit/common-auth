import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import * as fs from 'node:fs/promises'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  createDumper,
  type DumpOptions,
  sweepDumpDirectory,
} from '../../src/dump/index.js'
import { makeTempDir } from '../fixtures/scratch.js'

const MASK = '***REDACTED***'
let root: string
let dumpDir: string

beforeEach(async () => {
  root = await makeTempDir('common-auth-dump-')
  dumpDir = join(root, 'dumps')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function dumper(options: Partial<DumpOptions> = {}) {
  return createDumper({ dir: dumpDir, enabled: true, ...options })
}

function requireFile(files: string[], suffix: string): string {
  const matches = files.filter((name) => name.endsWith(suffix))
  expect(matches.length).toBe(1)
  return matches[0]!
}

async function readJson(name: string) {
  return JSON.parse(await readFile(join(dumpDir, name), 'utf8'))
}

async function readMetas() {
  const names = (await readdir(dumpDir)).filter((name) =>
    name.endsWith('.meta.json'),
  )
  return await Promise.all(names.map(readJson))
}

const turns = (count: number) =>
  JSON.stringify({
    model: 'any-model',
    input: Array.from({ length: count }, (_unused, i) => ({
      role: 'user',
      content: `turn ${i}`,
    })),
  })

describe('request dumps', () => {
  test('dumps final HTTP body and redacted request metadata when enabled', async () => {
    const result = await dumper().dump({
      session: 'ses_dump_http',
      channel: 'http',
      phase: 'main',
      bodyText: JSON.stringify({ input: [{ role: 'user', content: 'hi' }] }),
      url: 'https://provider.example/v1/generate',
      method: 'POST',
      status: 200,
      headers: {
        authorization: 'Bearer request-token',
        'x-api-key': 'request-key',
        cookie: 'session=1',
        'content-type': 'application/json',
      },
    })
    expect(result).toBeDefined()

    const files = await readdir(dumpDir)
    const bodyFile = requireFile(files, '.body.json')
    const metaFile = requireFile(files, '.meta.json')
    const requestFile = requireFile(files, '.request.json')
    expect(join(dumpDir, bodyFile)).toBe(result!.files.body)

    expect((await stat(dumpDir)).mode & 0o777).toBe(0o700)
    for (const file of [bodyFile, metaFile, requestFile]) {
      expect((await stat(join(dumpDir, file))).mode & 0o777).toBe(0o600)
    }
    expect(await readJson(metaFile)).toMatchObject({
      channel: 'http',
      phase: 'main',
      status: 200,
      session: 'ses_dump_http',
      body: { parseable: true },
      diff: null,
    })
    const request = await readJson(requestFile)
    expect(request).toMatchObject({
      url: 'https://provider.example/v1/generate',
      method: 'POST',
      headers: {
        authorization: MASK,
        'x-api-key': MASK,
        cookie: MASK,
        'content-type': 'application/json',
      },
    })
    expect(JSON.stringify(request)).not.toContain('request-token')
  })

  test('recovers a diff baseline from disk after a restart', async () => {
    await dumper().dump({
      session: 'ses_restart_baseline',
      channel: 'http',
      bodyText: turns(1),
    })
    // A new dumper stands in for the restarted process: its memory is empty.
    await dumper().dump({
      session: 'ses_restart_baseline',
      channel: 'http',
      bodyText: turns(2),
    })

    // Find the dump written after the restart by its non-null diff, not by
    // file order: two dumps in one millisecond sort by pid and counter.
    const metas = await readMetas()
    expect(metas.length).toBe(2)
    const afterRestart = metas.find((meta) => meta.diff !== null)
    expect(afterRestart).toBeDefined()
    expect(afterRestart.baselineSource).toBe('disk')
    expect(afterRestart.diff.changed).toBe(true)
    // An append changes the body after its common prefix, never at byte zero.
    expect(afterRestart.diff.firstByte).toBeGreaterThan(0)
    expect(afterRestart.diff.previousBytes).toBe(turns(1).length)
  })

  test('seeds a direct-request diff from the latest same-session dump after restart', async () => {
    let t = Date.UTC(2026, 0, 1)
    const first = dumper({ now: () => t })
    await first.dump({
      session: 'ses_latest',
      channel: 'http',
      bodyText: turns(1),
    })
    t += 1000
    await first.dump({
      session: 'ses_latest',
      channel: 'http',
      bodyText: turns(2),
    })
    t += 1000
    const restarted = await dumper({ now: () => t }).dump({
      session: 'ses_latest',
      channel: 'http',
      bodyText: turns(3),
    })
    const meta = await readJson(restarted!.files.metadata.split('/').pop()!)
    expect(meta.baselineSource).toBe('disk')
    expect(meta.diff.previousBytes).toBe(turns(2).length)
  })

  test('recognizes a tagged prewarm as the latest same-session restart baseline', async () => {
    let t = Date.UTC(2026, 0, 1)
    const first = dumper({ now: () => t })
    await first.dump({
      session: 'ses_phase',
      channel: 'websocket',
      phase: 'main',
      bodyText: turns(1),
    })
    t += 1000
    await first.dump({
      session: 'ses_phase',
      channel: 'websocket',
      phase: 'prewarm',
      bodyText: turns(2),
    })
    t += 1000
    const restarted = await dumper({ now: () => t }).dump({
      session: 'ses_phase',
      channel: 'websocket',
      phase: 'main',
      bodyText: turns(2),
    })
    const meta = await readJson(restarted!.files.metadata.split('/').pop()!)
    expect(meta.baselineSource).toBe('disk')
    expect(meta.diff.changed).toBe(false)
  })

  test('does not borrow a diff baseline from a different session', async () => {
    await dumper().dump({
      session: 'ses_baseline_owner',
      channel: 'http',
      bodyText: JSON.stringify({ input: ['owner'] }),
    })
    await dumper().dump({
      session: 'ses_baseline_other',
      channel: 'http',
      bodyText: JSON.stringify({ input: ['other'] }),
    })
    await dumper().dump({
      session: 'ses_baseline_owner',
      channel: 'websocket',
      bodyText: JSON.stringify({ input: ['owner'] }),
    })

    const metas = await readMetas()
    expect(metas.length).toBe(3)
    for (const meta of metas) {
      expect(meta.baselineSource).toBeUndefined()
      expect(meta.diff).toBeNull()
    }
  })

  test('sessions whose filename segments collide do not share a baseline', async () => {
    // Both sanitise to the filename segment `ses-a`.
    await dumper().dump({
      session: 'ses/a',
      channel: 'http',
      bodyText: turns(1),
    })
    await dumper().dump({
      session: 'ses:a',
      channel: 'http',
      bodyText: turns(2),
    })

    const metas = await readMetas()
    expect(metas.length).toBe(2)
    for (const meta of metas) expect(meta.diff).toBeNull()
  })

  test('dumps from two processes in the same directory never collide', async () => {
    const instant = () => Date.UTC(2026, 0, 1)
    const processA = dumper({ pid: 101, now: instant })
    const processB = dumper({ pid: 202, now: instant })
    // Same session, same millisecond, both counters at one.
    const [a, b] = await Promise.all([
      processA.dump({
        session: 'ses_shared',
        channel: 'http',
        bodyText: '{"from":"a"}',
      }),
      processB.dump({
        session: 'ses_shared',
        channel: 'http',
        bodyText: '{"from":"b"}',
      }),
    ])
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.id).not.toBe(b!.id)
    expect(a!.id).toContain('-101-')
    expect(b!.id).toContain('-202-')
    expect((await readdir(dumpDir)).length).toBe(6)
    expect(await readFile(a!.files.body, 'utf8')).toBe('{"from":"a"}')
    expect(await readFile(b!.files.body, 'utf8')).toBe('{"from":"b"}')
  })

  test('two dumpers in one process never collide in the same millisecond', async () => {
    const instant = () => Date.UTC(2026, 0, 1)
    // One plugin instance per project in a single process: same pid, same
    // millisecond, same session.
    const first = dumper({ pid: 303, now: instant })
    const second = dumper({ pid: 303, now: instant })
    const a = await first.dump({
      session: 'ses_shared',
      channel: 'http',
      bodyText: '{"from":"a"}',
    })
    const b = await second.dump({
      session: 'ses_shared',
      channel: 'http',
      bodyText: '{"from":"b"}',
    })
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.id).not.toBe(b!.id)
    expect((await readdir(dumpDir)).length).toBe(6)
  })

  test('preserves non-secret JSON dump body bytes', async () => {
    const bodyText = '{\n  "model": "any-model",\n  "input": []\n}\n'
    await dumper().dump({
      session: 'ses_dump_fidelity',
      channel: 'http',
      bodyText,
    })
    const bodyFile = requireFile(await readdir(dumpDir), '.body.json')
    expect(await readFile(join(dumpDir, bodyFile), 'utf8')).toBe(bodyText)
  })

  test('records the internal serving account without exposing a ChatGPT account id', async () => {
    await dumper({ secretKeys: ['chatgpt-account-id'] }).dump({
      session: 'ses_dump_account',
      channel: 'http',
      accountId: 'work-alt',
      bodyText: JSON.stringify({ input: [] }),
      headers: { 'chatgpt-account-id': 'chatgpt-account-secret' },
    })
    const files = await readdir(dumpDir)
    const metadata = await readJson(requireFile(files, '.meta.json'))
    const request = await readJson(requireFile(files, '.request.json'))
    expect(metadata.accountId).toBe('work-alt')
    expect(request.accountId).toBe('work-alt')
    expect(request.headers['chatgpt-account-id']).toBe(MASK)
    expect(JSON.stringify({ metadata, request })).not.toContain(
      'chatgpt-account-secret',
    )
  })

  test('redacts credentials from JSON dump bodies', async () => {
    const bearer = 'Bearer dump-body-token'
    const accountID = 'account-secret'
    const metadataToken = 'Bearer client-metadata-token'
    const prompt = 'keep this prompt for cache debugging'
    await dumper({ secretKeys: ['chatgpt-account-id'] }).dump({
      session: 'ses_dump_redaction',
      channel: 'http',
      bodyText: JSON.stringify({
        authorization: bearer,
        chatgptAccountId: accountID,
        'chatgpt-account-id': accountID,
        client_metadata: { trace: metadataToken },
        input: [
          { role: 'user', content: [{ type: 'input_text', text: prompt }] },
        ],
      }),
    })
    const bodyFile = requireFile(await readdir(dumpDir), '.body.json')
    const body = await readFile(join(dumpDir, bodyFile), 'utf8')
    expect(body).not.toContain(bearer)
    expect(body).not.toContain(accountID)
    expect(body).not.toContain(metadataToken)
    expect(body).not.toContain('\n')
    expect(body).toContain(prompt)
  })

  test('scrubs token-shaped strings from a body that is not JSON', async () => {
    await dumper().dump({
      session: 'ses_raw',
      channel: 'http',
      bodyText: 'grant=1&auth=Bearer raw-body-token&prompt=keep',
    })
    const body = await readFile(
      join(dumpDir, requireFile(await readdir(dumpDir), '.body.json')),
      'utf8',
    )
    expect(body).not.toContain('raw-body-token')
    expect(body).toContain('prompt=keep')
  })

  test('keeps tool schemas intact while scrubbing credentials inside them', async () => {
    const leaked = 'Bearer schema-description-token'
    await dumper().dump({
      session: 'ses_dump_schema',
      channel: 'http',
      bodyText: JSON.stringify({
        api_key: 'top-level-secret',
        tools: [
          {
            type: 'function',
            name: 'call_api',
            parameters: {
              type: 'object',
              properties: {
                // Declares an argument named api_key; it holds no credential.
                api_key: { type: 'string', description: 'the caller key' },
                auth_token: { type: 'string', description: leaked },
              },
            },
          },
        ],
      }),
    })
    const body = await readFile(
      join(dumpDir, requireFile(await readdir(dumpDir), '.body.json')),
      'utf8',
    )
    const parsed = JSON.parse(body)
    const properties = parsed.tools[0].parameters.properties
    // The parameter is still a schema object, not replaced by the mask.
    expect(properties.api_key).toEqual({
      type: 'string',
      description: 'the caller key',
    })
    expect(properties.auth_token.type).toBe('string')
    expect(body).not.toContain(leaked)
    // A top-level api_key, outside the tools, is still a credential.
    expect(parsed.api_key).toBe(MASK)
  })

  test('diffs the redacted text so offsets index the dumped file', async () => {
    const d = dumper()
    const first = JSON.stringify({
      authorization: 'Bearer first-token',
      input: 'a',
    })
    const second = JSON.stringify({
      authorization: 'Bearer other-token',
      input: 'ab',
    })
    await d.dump({ session: 'ses_diff', channel: 'http', bodyText: first })
    const result = await d.dump({
      session: 'ses_diff',
      channel: 'http',
      bodyText: second,
    })
    const meta = await readJson(result!.files.metadata.split('/').pop()!)
    const dumped = await readFile(result!.files.body, 'utf8')
    // The tokens differ but both redact to the mask, so the first change is
    // the input; its offset is a position in the file on disk.
    expect(meta.baselineSource).toBe('memory')
    expect(meta.diff.firstByte).toBe(dumped.indexOf('"ab"') + 2)
    expect(meta.diff.currentBytes).toBe(dumped.length)
  })

  test('setEnabled switches dumps at runtime without recreating the dumper', async () => {
    const d = createDumper({ dir: dumpDir })
    expect(d.isEnabled()).toBe(false)
    expect(
      await d.dump({ session: 's', channel: 'http', bodyText: '{}' }),
    ).toBeUndefined()
    await expect(readdir(dumpDir)).rejects.toThrow()

    d.setEnabled(true)
    expect(
      await d.dump({ session: 's', channel: 'http', bodyText: '{}' }),
    ).toBeDefined()
    expect((await readdir(dumpDir)).length).toBe(3)

    d.setEnabled(false)
    expect(
      await d.dump({ session: 's', channel: 'http', bodyText: '{}' }),
    ).toBeUndefined()
    expect((await readdir(dumpDir)).length).toBe(3)
  })

  test('tightens an existing dump directory to 0700', async () => {
    await mkdir(dumpDir, { mode: 0o755 })
    await chmod(dumpDir, 0o755)
    await dumper().dump({ session: 's', channel: 'http', bodyText: '{}' })
    expect((await stat(dumpDir)).mode & 0o777).toBe(0o700)
  })

  test('stores the plugin body summary computed on the redacted body', async () => {
    const summarize = mock((body: Record<string, unknown>) => ({
      model: body.model,
      authorization: body.authorization,
    }))
    await dumper({ summarize }).dump({
      session: 's',
      channel: 'http',
      bodyText: JSON.stringify({
        model: 'any-model',
        authorization: 'Bearer x',
      }),
    })
    const meta = (await readMetas())[0]
    expect(meta.body).toEqual({
      parseable: true,
      model: 'any-model',
      authorization: MASK,
    })
  })

  test('a failed dump returns nothing and logs instead of throwing', async () => {
    const blocker = join(root, 'not-a-directory')
    await writeFile(blocker, 'file')
    const logger = { debug: mock(() => {}), warn: mock(() => {}) }
    const result = await createDumper({
      dir: join(blocker, 'dumps'),
      enabled: true,
      logger,
    }).dump({ session: 's', channel: 'http', bodyText: '{}' })
    expect(result).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      'request dump failed',
      expect.objectContaining({ session: 's' }),
    )
  })
})

/** A file name of the shape a dumper writes: time, pid, counter, session, channel. */
function dumpArtifactName(
  id: number,
  kind: 'body' | 'meta' | 'request' | 'response' = 'body',
) {
  return `2026-07-17T12-00-00-000Z-4242-${String(id).padStart(6, '0')}-session-http.${kind}.json`
}

async function writeAged(path: string, bytes: string, mtimeMs: number) {
  await writeFile(path, bytes)
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs))
}

/** Poll until `check` holds; the automatic sweep runs off the request path. */
async function eventually(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error('condition never held')
}

describe('response artifacts', () => {
  test('failed request dumps return no handle or orphan response artifact', async () => {
    await mkdir(dumpDir, { recursive: true })
    const original = fs.writeFile
    const spy = spyOn(fs, 'writeFile').mockImplementation((async (
      ...args: Parameters<typeof fs.writeFile>
    ) => {
      if (String(args[0]).endsWith('.meta.json')) throw new Error('disk full')
      return original(...args)
    }) as typeof fs.writeFile)
    const d = dumper()
    let handle: Awaited<ReturnType<typeof d.dump>>
    try {
      handle = await d.dump({
        session: 'ses-failure',
        channel: 'http',
        bodyText: '{}',
      })
    } finally {
      spy.mockRestore()
    }
    expect(handle).toBeUndefined()
    expect(await d.dumpResponse(handle, { status: 200 })).toBeUndefined()
    expect(
      (await readdir(dumpDir)).some((name) => name.endsWith('.response.json')),
    ).toBe(false)
  })

  test('response artifacts sanitize message fields and preserve diagnostics presence', async () => {
    const d = dumper()
    const handle = await d.dump({
      session: 'ses-a',
      channel: 'http',
      bodyText: '{}',
    })
    expect(handle).toBeDefined()
    const written = await d.dumpResponse(handle, {
      status: 200,
      requestId: 'msg_provider',
      usage: { input_tokens: 1 },
      fields: {
        model: 'any-model',
        diagnostics: null,
        trace: 'Bearer response-secret',
      },
    })
    expect(written).toBe(handle!.responseFile)
    expect(handle!.responseFile).toBe(
      handle!.files.body.replace(/\.body\.json$/, '.response.json'),
    )
    const artifact = JSON.parse(await readFile(handle!.responseFile, 'utf8'))
    expect(artifact).toEqual({
      status: 200,
      requestId: 'msg_provider',
      usage: { input_tokens: 1 },
      model: 'any-model',
      diagnostics: null,
      trace: MASK,
      complete: true,
    })
    expect(JSON.stringify(artifact)).not.toContain('response-secret')
    expect((await stat(handle!.responseFile)).mode & 0o777).toBe(0o600)
  })

  test('response artifacts preserve opening usage while recording terminal usage and reason', async () => {
    const d = dumper()
    const handle = await d.dump({
      session: 'ses-usage',
      channel: 'http',
      bodyText: '{}',
    })
    const opening = {
      input_tokens: 10,
      cache_read_input_tokens: 30,
      output_tokens: 3,
    }
    await d.dumpResponse(handle, {
      status: 200,
      requestId: 'msg_provider_usage',
      usage: opening,
      complete: false,
    })
    await d.dumpResponse(handle, {
      status: 200,
      requestId: 'msg_provider_usage',
      usage: { ...opening, output_tokens: 1749 },
      fields: { stop_reason: 'end_turn' },
    })
    expect(JSON.parse(await readFile(handle!.responseFile, 'utf8'))).toEqual({
      status: 200,
      requestId: 'msg_provider_usage',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 30,
        output_tokens: 1749,
      },
      stop_reason: 'end_turn',
      complete: true,
    })
    // The replacement went through a staging file that is gone again.
    expect(
      (await readdir(dumpDir)).filter((name) => name.endsWith('.partial')),
    ).toEqual([])
  })

  test('response artifacts mark a stream incomplete when no terminal frame arrives', async () => {
    const d = dumper()
    const handle = await d.dump({
      session: 'ses-incomplete',
      channel: 'http',
      bodyText: '{}',
    })
    await d.dumpResponse(handle, {
      status: 200,
      usage: { input_tokens: 10, output_tokens: 3 },
      complete: false,
    })
    const artifact = JSON.parse(await readFile(handle!.responseFile, 'utf8'))
    expect(artifact).toMatchObject({ status: 200, complete: false })
    expect(artifact.stop_reason).toBeUndefined()
  })

  test('does not follow a pre-planted predictable partial symlink', async () => {
    const d = dumper()
    const handle = await d.dump({
      session: 's',
      channel: 'http',
      bodyText: '{}',
    })
    const targetFile = join(root, 'target.txt')
    await writeFile(targetFile, 'do not overwrite')
    await symlink(targetFile, `${handle!.responseFile}.partial`)
    await symlink(targetFile, handle!.responseFile)

    await d.dumpResponse(handle, { status: 200 })

    expect(await readFile(targetFile, 'utf8')).toBe('do not overwrite')
    expect((await lstat(handle!.responseFile)).isSymbolicLink()).toBe(false)
    expect(JSON.parse(await readFile(handle!.responseFile, 'utf8'))).toEqual({
      status: 200,
      complete: true,
    })
  })

  test('a failed response write returns nothing and logs instead of throwing', async () => {
    const logger = { debug: mock(() => {}), warn: mock(() => {}) }
    const d = dumper({ logger })
    const handle = await d.dump({
      session: 's',
      channel: 'http',
      bodyText: '{}',
    })
    await rm(dumpDir, { recursive: true, force: true })
    expect(await d.dumpResponse(handle, { status: 500 })).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      'response dump failed',
      expect.objectContaining({ id: handle!.id }),
    )
  })
})

describe('failed dump cleanup', () => {
  /** Fail the request file's write after it has written half its bytes. */
  function failRequestWrite(code?: string) {
    const original = fs.writeFile
    return spyOn(fs, 'writeFile').mockImplementation((async (
      ...args: Parameters<typeof fs.writeFile>
    ) => {
      if (String(args[0]).endsWith('.request.json')) {
        if (code === 'EEXIST') {
          // Another writer owns this name: its file is there, ours never was.
          await original(args[0], 'foreign')
          throw Object.assign(new Error('exists'), { code })
        }
        await original(args[0], '{"half')
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      }
      return original(...args)
    }) as typeof fs.writeFile)
  }

  test('a failed dump leaves the files it wrote by default', async () => {
    await mkdir(dumpDir, { recursive: true })
    const spy = failRequestWrite()
    try {
      expect(
        await dumper().dump({ session: 's', channel: 'http', bodyText: '{}' }),
      ).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect((await readdir(dumpDir)).length).toBe(3)
  })

  test('a failed dump removes every file of its group when cleanup is on', async () => {
    await mkdir(dumpDir, { recursive: true })
    const spy = failRequestWrite()
    try {
      expect(
        await dumper({ cleanupFailedDumps: true }).dump({
          session: 's',
          channel: 'http',
          bodyText: '{}',
        }),
      ).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect(await readdir(dumpDir)).toEqual([])
  })

  test('cleanup leaves a file another writer created at the same name', async () => {
    await mkdir(dumpDir, { recursive: true })
    const spy = failRequestWrite('EEXIST')
    try {
      await dumper({ cleanupFailedDumps: true }).dump({
        session: 's',
        channel: 'http',
        bodyText: '{}',
      })
    } finally {
      spy.mockRestore()
    }
    const names = await readdir(dumpDir)
    expect(names.length).toBe(1)
    expect(names[0]).toEndWith('.request.json')
    expect(await readFile(join(dumpDir, names[0]!), 'utf8')).toBe('foreign')
  })
})

describe('dump directory byte cap', () => {
  test('sweeps tagged dumps with a maximum-length affinity segment', async () => {
    await dumper().dump({
      session: 'a'.repeat(80),
      channel: 'http',
      phase: 'prewarm',
      bodyText: '{"messages":[]}',
    })
    expect(await readdir(dumpDir)).not.toEqual([])
    const result = await sweepDumpDirectory({
      dir: dumpDir,
      maxBytes: 1,
      minAgeMs: 0,
      now: Date.now() + 1,
    })
    expect(result.removed).toBeGreaterThan(0)
    expect(await readdir(dumpDir)).toEqual([])
  })

  test('dump sweep recognizes response artifacts', async () => {
    await mkdir(dumpDir)
    await writeAged(
      join(dumpDir, dumpArtifactName(1, 'response')),
      '12345678',
      1_000,
    )
    expect(await sweepDumpDirectory({ dir: dumpDir, maxBytes: 1 })).toEqual({
      removed: 1,
      freedBytes: 8,
    })
  })

  test('dump sweep deletes oldest files until the directory is under its cap', async () => {
    await mkdir(dumpDir)
    const oldFile = join(dumpDir, dumpArtifactName(1))
    const middleFile = join(dumpDir, dumpArtifactName(2, 'meta'))
    const newestFile = join(dumpDir, dumpArtifactName(3, 'request'))
    await writeAged(oldFile, '12345678', 1_000)
    await writeAged(middleFile, '12345678', 2_000)
    await writeAged(newestFile, '12345678', 3_000)

    const result = await sweepDumpDirectory({
      dir: dumpDir,
      maxBytes: 12,
      protectedPaths: [newestFile],
    })

    expect(result).toEqual({ removed: 2, freedBytes: 16 })
    expect(await readdir(dumpDir)).toEqual([dumpArtifactName(3, 'request')])
  })

  test('the sweep keeps a protected dump even when it is the oldest', async () => {
    await mkdir(dumpDir)
    const oldest = join(dumpDir, dumpArtifactName(1))
    await writeAged(oldest, '12345678', 1_000)
    await writeAged(join(dumpDir, dumpArtifactName(2)), '12345678', 2_000)

    expect(
      await sweepDumpDirectory({
        dir: dumpDir,
        maxBytes: 8,
        protectedPaths: [oldest],
      }),
    ).toEqual({ removed: 1, freedBytes: 8 })
    expect(await readdir(dumpDir)).toEqual([dumpArtifactName(1)])
  })

  test('evicts complete dump artifact groups instead of orphaning request pairs', async () => {
    await mkdir(dumpDir)
    await writeAged(
      join(dumpDir, dumpArtifactName(1, 'body')),
      '12345678',
      1_000,
    )
    await writeAged(
      join(dumpDir, dumpArtifactName(1, 'meta')),
      '12345678',
      2_000,
    )
    await writeAged(
      join(dumpDir, dumpArtifactName(2, 'body')),
      '12345678',
      3_000,
    )
    await writeAged(
      join(dumpDir, dumpArtifactName(2, 'meta')),
      '12345678',
      4_000,
    )

    // Removing one file would satisfy this cap but leave an unusable orphan.
    // The sweep must evict both artifacts belonging to the oldest request.
    expect(await sweepDumpDirectory({ dir: dumpDir, maxBytes: 24 })).toEqual({
      removed: 2,
      freedBytes: 16,
    })
    expect((await readdir(dumpDir)).sort()).toEqual(
      [dumpArtifactName(2, 'body'), dumpArtifactName(2, 'meta')].sort(),
    )
  })

  test('sweeps artifacts whose request counter has grown to seven digits', async () => {
    await mkdir(dumpDir)
    await writeAged(
      join(
        dumpDir,
        '2026-07-17T12-00-00-000Z-4242-1000000-session-http.body.json',
      ),
      '12345678',
      1_000,
    )
    expect(await sweepDumpDirectory({ dir: dumpDir, maxBytes: 1 })).toEqual({
      removed: 1,
      freedBytes: 8,
    })
    expect(await readdir(dumpDir)).toEqual([])
  })

  describe('dump sweep safety guard', () => {
    test('refuses a configured symlinked dump directory without deleting target files', async () => {
      const targetDir = join(root, 'target')
      await mkdir(targetDir)
      await writeAged(join(targetDir, dumpArtifactName(1)), '12345678', 1_000)
      await symlink(targetDir, dumpDir)

      expect(await sweepDumpDirectory({ dir: dumpDir, maxBytes: 1 })).toEqual({
        removed: 0,
        freedBytes: 0,
      })
      expect(await readdir(targetDir)).toEqual([dumpArtifactName(1)])
    })
  })

  test('enforces the cap in a configured custom dump directory', async () => {
    await mkdir(dumpDir)
    await writeAged(join(dumpDir, dumpArtifactName(1)), '12345678', 1_000)
    await writeAged(
      join(dumpDir, dumpArtifactName(2, 'meta')),
      '12345678',
      2_000,
    )
    await writeAged(
      join(dumpDir, 'system.log'),
      'unrelated file must survive',
      500,
    )

    expect(await sweepDumpDirectory({ dir: dumpDir, maxBytes: 8 })).toEqual({
      removed: 1,
      freedBytes: 8,
    })
    expect((await readdir(dumpDir)).sort()).toEqual(
      [dumpArtifactName(2, 'meta'), 'system.log'].sort(),
    )
  })

  test('disables dump sweeping when the configured cap is zero', async () => {
    await mkdir(dumpDir)
    await writeAged(join(dumpDir, dumpArtifactName(1)), '12345678', 1_000)
    expect(await sweepDumpDirectory({ dir: dumpDir, maxBytes: 0 })).toEqual({
      removed: 0,
      freedBytes: 0,
    })
    expect(await dumper().sweep()).toEqual({ removed: 0, freedBytes: 0 })
    expect(await readdir(dumpDir)).toEqual([dumpArtifactName(1)])
  })

  test('preserves files younger than the sweep newness floor', async () => {
    await mkdir(dumpDir)
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    await writeAged(join(dumpDir, dumpArtifactName(1)), '12345678', now)
    expect(
      await sweepDumpDirectory({ dir: dumpDir, maxBytes: 1, now }),
    ).toEqual({ removed: 0, freedBytes: 0 })
    expect(await readdir(dumpDir)).toEqual([dumpArtifactName(1)])
  })

  test('preserves fresh partials and reclaims stale partials even under the cap', async () => {
    await mkdir(dumpDir)
    const now = Date.parse('2026-07-17T12:00:00.000Z')
    const fresh = `${dumpArtifactName(1, 'response')}.0123456789abcdef01234567.partial`
    const stale = `${dumpArtifactName(2, 'response')}.0123456789abcdef01234567.partial`
    await writeAged(join(dumpDir, fresh), '12345678', now)
    await writeAged(join(dumpDir, stale), '12345678', now - 11 * 60 * 1000)

    expect(
      await sweepDumpDirectory({ dir: dumpDir, maxBytes: 100, now }),
    ).toEqual({ removed: 1, freedBytes: 8 })
    expect(await readdir(dumpDir)).toEqual([fresh])
  })

  test('a capped dumper evicts the oldest whole dumps after writing a new one', async () => {
    await mkdir(dumpDir)
    for (const kind of ['body', 'meta', 'request', 'response'] as const) {
      await writeAged(
        join(dumpDir, dumpArtifactName(1, kind)),
        '12345678',
        1_000,
      )
    }
    const result = await dumper({ maxBytes: 1 }).dump({
      session: 's',
      channel: 'http',
      bodyText: '{}',
    })
    // The old dump is evicted with all four of its files; the new dump is
    // younger than the one-minute floor and is the dump just written, so it stays.
    await eventually(async () => (await readdir(dumpDir)).length === 3)
    expect((await readdir(dumpDir)).sort()).toEqual(
      Object.values(result!.files)
        .map((path) => path.split('/').pop()!)
        .sort(),
    )
  })

  test('an uncapped dumper never evicts old dumps', async () => {
    await mkdir(dumpDir)
    await writeAged(join(dumpDir, dumpArtifactName(1)), '12345678', 1_000)
    await dumper().dump({ session: 's', channel: 'http', bodyText: '{}' })
    await Bun.sleep(100)
    expect(await readdir(dumpDir)).toContain(dumpArtifactName(1))
  })

  test('the automatic sweep runs at most once per interval while sweep runs now', async () => {
    await mkdir(dumpDir)
    let t = Date.now()
    const d = dumper({ maxBytes: 1, now: () => t, sweepMinAgeMs: 0 })
    await d.dump({ session: 's', channel: 'http', bodyText: '{}' })
    await eventually(async () => (await readdir(dumpDir)).length === 3)
    await writeAged(join(dumpDir, dumpArtifactName(1)), '12345678', 1_000)
    t += 1000
    await d.dump({ session: 's', channel: 'http', bodyText: '{}' })
    await Bun.sleep(100)
    expect(await readdir(dumpDir)).toContain(dumpArtifactName(1))

    expect((await d.sweep()).removed).toBeGreaterThan(0)
    expect(await readdir(dumpDir)).not.toContain(dumpArtifactName(1))
  })
})

for (const kind of ['file', 'symlink'] as const) {
  test(`response dump refuses an existing stage ${kind}`, async () => {
    const d = dumper({ stageName: () => 'seeded' })
    const handle = await d.dump({
      session: 'security',
      channel: 'http',
      bodyText: '{}',
    })
    expect(handle).toBeDefined()
    const stage = `${handle!.responseFile}.seeded.partial`
    const victim = join(root, 'victim')
    await writeFile(victim, 'untouched')
    if (kind === 'symlink') await symlink(victim, stage)
    else await writeFile(stage, 'stale')
    expect(await d.dumpResponse(handle, { status: 200 })).toBeUndefined()
    expect(await readFile(victim, 'utf8')).toBe('untouched')
    expect((await lstat(stage)).isSymbolicLink()).toBe(kind === 'symlink')
    if (kind === 'file') expect(await readFile(stage, 'utf8')).toBe('stale')
    await expect(lstat(handle!.responseFile)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
}
