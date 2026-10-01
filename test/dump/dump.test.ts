import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { createDumper, type DumpOptions } from '../../src/dump/index.js'
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
