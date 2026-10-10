import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { openPiSlot, PiSlotError } from '../../src/pi-slot/index.js'
import { acquirePiLock } from '../../src/pi-slot/lock.js'

const key = 'pi-vault-disabled'
const provider = 'openai-codex'
const original =
  '{\n  "openai-codex" : { "type":"oauth", "access":"old-access", "refresh" : "original-refresh", "expires":1 },\n  "google": { "type" : "api_key", "key": "literal-google" }\n}\n'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})
async function fixture(text = original) {
  const root = await mkdtemp(join(tmpdir(), 'pi-slot-'))
  roots.push(root)
  const authPath = join(root, 'auth.json')
  const stashPath = join(root, 'private', 'slot.json')
  await writeFile(authPath, text, { mode: 0o600 })
  const options = { authPath, stashPath, provider, placeholderKey: key }
  return { root, authPath, stashPath, options, slot: openPiSlot(options) }
}
const bytes = (path: string) => readFile(path, 'utf8')
async function absent(path: string) {
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}
function child(
  mode: string,
  authPath: string,
  stashPath: string,
  boundary = '',
) {
  return Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'child.ts'),
      mode,
      authPath,
      stashPath,
      boundary,
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
}
async function locked(child: ReturnType<typeof Bun.spawn>) {
  if (!child.stdout || typeof child.stdout === 'number')
    throw new Error('Missing child stdout')
  const reader = child.stdout.getReader()
  const output = await reader.read()
  reader.releaseLock()
  expect(new TextDecoder().decode(output.value)).toContain('LOCKED')
}
async function finished(child: ReturnType<typeof Bun.spawn>, expected = 0) {
  const status = await child.exited
  const stderr =
    child.stderr && typeof child.stderr !== 'number'
      ? await new Response(child.stderr).text()
      : ''
  expect(stderr).toBe('')
  expect(status).toBe(expected)
}

const piRoot = fileURLToPath(
  new URL(
    '../../node_modules/@earendil-works/pi-coding-agent/dist/core/',
    import.meta.url,
  ),
)
const { isCommandConfigValue, getConfigValueEnvVarNames, resolveConfigValue } =
  await import(`${piRoot}resolve-config-value.js`)

describe('pi slot', () => {
  test('round trip preserves exact provider and other provider bytes', async () => {
    const f = await fixture()
    expect(await f.slot.inspect()).toEqual({
      slot: 'original',
      stash: 'missing',
    })
    await f.slot.enterVault()
    const swapped = await bytes(f.authPath)
    expect(swapped).toContain(
      '"google": { "type" : "api_key", "key": "literal-google" }',
    )
    expect(JSON.parse(swapped)[provider]).toEqual({ type: 'api_key', key })
    expect((await stat(f.authPath)).mode & 0o777).toBe(0o600)
    expect((await stat(f.stashPath)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(f.stashPath))).mode & 0o777).toBe(0o700)
    const stash = await bytes(f.stashPath)
    await f.slot.enterVault()
    expect(await bytes(f.stashPath)).toBe(stash)
    expect(await bytes(f.authPath)).toBe(swapped)
    expect(await f.slot.inspect()).toEqual({
      slot: 'placeholder',
      stash: 'valid',
    })
    expect(await f.slot.exitVault()).toBe('restored')
    expect(await bytes(f.authPath)).toBe(original)
    await absent(f.stashPath)
    expect(await f.slot.exitVault()).toBe('nothing-to-do')
  })

  test('empty slot round trip deletes only the placeholder', async () => {
    for (const text of [
      '{  \n}\n',
      '{"google": { "type":"api_key", "key":"keep" }\n}\n',
    ]) {
      const f = await fixture(text)
      expect((await f.slot.inspect()).slot).toBe('empty')
      await f.slot.enterVault()
      expect(JSON.parse(await bytes(f.authPath))[provider]).toEqual({
        type: 'api_key',
        key,
      })
      expect(JSON.parse(await bytes(f.stashPath)).entry).toBeNull()
      expect(await f.slot.exitVault()).toBe('restored')
      expect(await bytes(f.authPath)).toBe(text)
    }
  })

  test('raw scan preserves escapes Unicode and nested provider values', async () => {
    const credential =
      '{ "type":"oauth", "refresh":"token", "access":"quoted\\"} ,", "expires":1, "extra":[{"key":"雪"}, [false,null]] }'
    for (const text of [
      `{ "openai-codex":${credential}, "google":{"type":"api_key","key":"last"} }`,
      `{ "google":{"type":"api_key","key":"first"}, "openai-codex":${credential} }`,
      `{ "google":{"type":"api_key","key":"first"}, "openai-codex":${credential}, "anthropic":{"type":"api_key","key":"last"} }`,
    ]) {
      const f = await fixture(text)
      await f.slot.enterVault()
      expect(JSON.parse(await bytes(f.authPath))[provider]).toEqual({
        type: 'api_key',
        key,
      })
      await f.slot.exitVault()
      expect(await bytes(f.authPath)).toBe(text)
    }
  })

  test('foreign login exit conflict preserves both files', async () => {
    const f = await fixture()
    await f.slot.enterVault()
    const foreign =
      '{"openai-codex":{"type":"oauth","refresh":"new-login","access":"new","expires":2},"google":{"type":"api_key","key":"keep"}}'
    await writeFile(f.authPath, foreign)
    const stash = await bytes(f.stashPath)
    expect((await f.slot.inspect()).slot).toBe('foreign')
    expect(await f.slot.exitVault()).toBe('conflict')
    expect(await bytes(f.authPath)).toBe(foreign)
    expect(await bytes(f.stashPath)).toBe(stash)
  })

  test('foreign login enter refuses credential free and unchanged', async () => {
    const f = await fixture()
    await f.slot.enterVault()
    const foreign = '{"openai-codex":{"type":"api_key","key":"secret-foreign"}}'
    await writeFile(f.authPath, foreign)
    const stash = await bytes(f.stashPath)
    await expect(f.slot.enterVault()).rejects.toEqual(
      new PiSlotError('conflict'),
    )
    expect(await bytes(f.authPath)).toBe(foreign)
    expect(await bytes(f.stashPath)).toBe(stash)
  })

  test('placeholder refuses all Pi command and interpolation syntax', async () => {
    const f = await fixture()
    for (const unsafe of [
      '!echo secret',
      '$TOKEN',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Pi interprets this literal as an environment reference.
      '${TOKEN}',
      'prefix-$TOKEN',
      '$$',
      '$!',
    ]) {
      expect(() =>
        openPiSlot({ ...f.options, placeholderKey: unsafe }),
      ).toThrow(new PiSlotError('invalid-options'))
    }
    expect(isCommandConfigValue(key)).toBe(false)
    expect(getConfigValueEnvVarNames(key)).toEqual([])
    expect(resolveConfigValue(key)).toBe(key)
    await f.slot.enterVault()
    const stored = JSON.parse(await bytes(f.authPath))[provider]
    expect(stored.type).toBe('api_key')
    expect(isCommandConfigValue(stored.key)).toBe(false)
    expect(resolveConfigValue(stored.key)).toBe(key)
  })

  test('invalid stash refuses both transitions unchanged', async () => {
    const f = await fixture()
    await f.slot.enterVault()
    const saved = JSON.parse(await bytes(f.stashPath))
    saved.entry.refresh = 'tampered-credential'
    const bad = JSON.stringify(saved)
    await writeFile(f.stashPath, bad)
    const auth = await bytes(f.authPath)
    await expect(f.slot.enterVault()).rejects.toEqual(
      new PiSlotError('invalid-stash'),
    )
    await expect(f.slot.exitVault()).rejects.toEqual(
      new PiSlotError('invalid-stash'),
    )
    expect(await bytes(f.authPath)).toBe(auth)
    expect(await bytes(f.stashPath)).toBe(bad)
  })

  test('missing stash never adopts or deletes a placeholder', async () => {
    const text = JSON.stringify({ [provider]: { type: 'api_key', key } })
    const f = await fixture(text)
    await expect(f.slot.enterVault()).rejects.toEqual(
      new PiSlotError('missing-stash'),
    )
    await expect(f.slot.exitVault()).rejects.toEqual(
      new PiSlotError('missing-stash'),
    )
    expect(await bytes(f.authPath)).toBe(text)
    await absent(f.stashPath)
  })

  test('malformed and duplicate auth refuse without rewriting', async () => {
    for (const text of [
      '{',
      '{"openai-codex":{},"openai-codex":{}}',
      '[]',
      '{"openai-codex":null}',
    ]) {
      const f = await fixture(text)
      await expect(f.slot.enterVault()).rejects.toEqual(
        new PiSlotError('invalid-auth'),
      )
      expect(await bytes(f.authPath)).toBe(text)
      await absent(f.stashPath)
    }
    const f = await fixture()
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"openai-codex":{"key":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ])
    await writeFile(f.authPath, invalidUtf8)
    await expect(f.slot.enterVault()).rejects.toEqual(
      new PiSlotError('invalid-auth'),
    )
    expect(await readFile(f.authPath)).toEqual(invalidUtf8)
    await absent(f.stashPath)
  })

  for (const [mode, boundary] of [
    ['crash-enter', 'stash-written'],
    ['crash-enter', 'auth-written'],
    ['crash-exit', 'auth-written'],
    ['crash-exit', 'stash-deleted'],
  ]) {
    test(`crash ${mode} after ${boundary} converges without loss`, async () => {
      const f = await fixture()
      if (mode === 'crash-exit') await f.slot.enterVault()
      const crashed = child(mode ?? '', f.authPath, f.stashPath, boundary)
      await finished(crashed, 73)
      // Abrupt exits may leave the lock directory. Age only the dead child's lock
      // to exercise the real stale takeover without a 30-second wall-clock wait.
      try {
        const old = new Date(Date.now() - 31_000)
        await utimes(`${f.authPath}.lock`, old, old)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (mode === 'crash-enter') {
        await f.slot.enterVault()
        expect(await f.slot.inspect()).toEqual({
          slot: 'placeholder',
          stash: 'valid',
        })
      }
      await f.slot.exitVault()
      expect(await bytes(f.authPath)).toBe(original)
      await absent(f.stashPath)
      expect(await readdir(dirname(f.stashPath))).toEqual([])
    })
  }

  test('waits for real Pi writer and preserves both writes', async () => {
    const f = await fixture()
    const writer = child('pi-writer', f.authPath, f.stashPath)
    try {
      await locked(writer)
      let done = false
      const swap = f.slot.enterVault().then(() => {
        done = true
      })
      await sleep(100)
      expect(done).toBe(false)
      expect(await bytes(f.authPath)).toBe(original)
      writer.stdin.write('release\n')
      writer.stdin.end()
      await finished(writer)
      await swap
      expect(JSON.parse(await bytes(f.authPath)).anthropic).toEqual({
        type: 'api_key',
        key: 'foreign-provider-key',
      })
      expect(JSON.parse(await bytes(f.authPath))[provider]).toEqual({
        type: 'api_key',
        key,
      })
      expect(await f.slot.exitVault()).toBe('restored')
      expect(JSON.parse(await bytes(f.authPath))[provider].refresh).toBe(
        'original-refresh',
      )
    } finally {
      writer.kill()
    }
  })

  test('real Pi writer waits for helper and preserves both writes', async () => {
    const f = await fixture()
    const holder = child('helper-holder', f.authPath, f.stashPath)
    let writer: ReturnType<typeof child> | undefined
    try {
      await locked(holder)
      writer = child('pi-writer', f.authPath, f.stashPath)
      const reader = writer.stdout.getReader()
      let acquired = false
      const ready = reader.read().then((output) => {
        acquired = true
        expect(new TextDecoder().decode(output.value)).toContain('LOCKED')
      })
      await sleep(100)
      expect(acquired).toBe(false)
      expect(await bytes(f.authPath)).toBe(original)
      holder.stdin.end()
      await finished(holder)
      await ready
      reader.releaseLock()
      writer.stdin.write('release\n')
      writer.stdin.end()
      await finished(writer)
      expect(JSON.parse(await bytes(f.authPath))[provider]).toEqual({
        type: 'api_key',
        key,
      })
      expect(JSON.parse(await bytes(f.authPath)).anthropic.key).toBe(
        'foreign-provider-key',
      )
      expect(await f.slot.exitVault()).toBe('restored')
    } finally {
      holder.kill()
      writer?.kill()
    }
  })

  test('stale lock uses mkdir takeover and fresh lock times out unchanged', async () => {
    const f = await fixture()
    await mkdir(`${f.authPath}.lock`)
    const old = new Date(Date.now() - 31_000)
    await utimes(`${f.authPath}.lock`, old, old)
    await f.slot.enterVault()
    await absent(`${f.authPath}.lock`)
    const auth = await bytes(f.authPath)
    const stash = await bytes(f.stashPath)
    await mkdir(`${f.authPath}.lock`)
    await expect(
      openPiSlot({ ...f.options, lockTimeoutMs: 10 }).exitVault(),
    ).rejects.toEqual(new PiSlotError('lock-timeout'))
    expect(await bytes(f.authPath)).toBe(auth)
    expect(await bytes(f.stashPath)).toBe(stash)
  })

  test('holder renews mtime and detects a replaced lock', async () => {
    const f = await fixture()
    let compromised = false
    const lease = await acquirePiLock(f.authPath, () => {
      compromised = true
    })
    try {
      const initial = (await stat(`${f.authPath}.lock`)).mtime.getTime()
      await sleep(15_100)
      const renewed = (await stat(`${f.authPath}.lock`)).mtime.getTime()
      expect(renewed).toBeGreaterThan(initial)
      const changed = new Date(renewed + 5_000)
      await utimes(`${f.authPath}.lock`, changed, changed)
      await sleep(15_100)
      expect(compromised).toBe(true)
      await lease.release()
      expect((await stat(`${f.authPath}.lock`)).mtime.getTime()).toBe(
        changed.getTime(),
      )
    } finally {
      await lease.release()
    }
  }, 35_000)

  test('published import graph contains only node builtins and common auth files', async () => {
    const packageJson = JSON.parse(
      await bytes(join(import.meta.dir, '../../package.json')),
    )
    expect(packageJson.exports['./pi-slot']).toEqual({
      types: './dist/pi-slot/index.d.ts',
      import: './dist/pi-slot/index.js',
    })
    const seen = new Set<string>()
    async function visit(path: string): Promise<void> {
      if (seen.has(path)) return
      seen.add(path)
      const source = await bytes(path)
      const imports = [
        ...source.matchAll(
          /(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g,
        ),
      ]
      for (const match of imports) {
        const specifier = match[1] ?? ''
        expect(specifier.startsWith('node:') || specifier.startsWith('.')).toBe(
          true,
        )
        if (specifier.startsWith('.'))
          await visit(resolve(dirname(path), specifier))
      }
    }
    await visit(join(import.meta.dir, '../../dist/pi-slot/index.js'))
    expect(seen.size).toBeGreaterThanOrEqual(3)
    const publicSlot = await import('@cortexkit/common-auth/pi-slot')
    expect(Object.keys(publicSlot).sort()).toEqual([
      'PiSlotError',
      'openPiSlot',
    ])
  })
})
