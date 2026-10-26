import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'jsonc-parser'
import {
  planOpenCodeRegistration,
  registerOpenCode,
  runSetup,
} from '../../src/setup/index.js'
import { fakeIO, plugin, terminal } from './helpers.js'

const pkg = '@cortexkit/opencode-test-auth'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('setup local registration', () => {
  for (const [name, entry] of [
    ['local path object', { package: '/build/auth', options: { flag: true } }],
    ['file URL', 'file:///build/auth'],
    ['config relative path', '../../../../build/auth'],
  ] as const) {
    test(`preserves ${name} instead of adding an npm registration`, () => {
      for (const generation of ['1', '2', 'both'] as const) {
        for (const key of ['plugin', 'plugins']) {
          const io = fakeIO()
          io.files.set(
            '/build/auth/package.json',
            JSON.stringify({ name: pkg }),
          )
          const text = `{\n  // local build\n  "${key}": ${JSON.stringify([entry, 'keep@1'])}\n}\n`
          for (const file of ['opencode', 'tui'])
            io.files.set(`/home/test/.config/opencode/${file}.jsonc`, text)
          const writes = planOpenCodeRegistration(plugin(), generation, io)
          expect(writes.every((write) => !write.changed)).toBe(true)
          for (const write of writes) expect(write.content).toBe(text)
        }
      }
    })
  }

  test('npm names still upgrade deduplicate and migrate', () => {
    for (const entry of [pkg, `${pkg}@0.1`, { package: `${pkg}@0.2` }]) {
      const io = fakeIO()
      io.files.set(
        '/home/test/.config/opencode/opencode.jsonc',
        JSON.stringify({ plugin: [entry, pkg] }),
      )
      const [write] = planOpenCodeRegistration(plugin(), '2', io)
      expect(write?.changed).toBe(true)
      expect(parse(write!.content)).toEqual({
        plugin: [],
        plugins: [`${pkg}@1.2.3`],
      })
    }
  })

  test('Windows paths and file URL rules work on every operating system', () => {
    for (const [spec, directory] of [
      ['C:\\Build\\auth', 'C:\\Build\\auth'],
      ['C:/Build/auth', 'C:\\Build\\auth'],
      ['..\\..\\..\\..\\Build\\auth', 'C:\\Build\\auth'],
      ['file:///C:/Build/auth', 'C:\\Build\\auth'],
      ['FILE:///C:/Build/auth', 'C:\\Build\\auth'],
      ['file:///c:/Build/auth', 'c:\\Build\\auth'],
      ['file://LOCALHOST/C:/Build/auth', 'C:\\Build\\auth'],
      ['file:///C:\\Build\\auth', 'C:\\Build\\auth'],
      ['file:///C:/Build/local%20%23%40auth', 'C:\\Build\\local #@auth'],
      ['\\\\server\\share\\Auth', '\\\\server\\share\\Auth'],
      ['file://SERVER/share/Auth', '\\\\server\\share\\Auth'],
    ]) {
      for (const entry of [
        spec,
        { package: spec, options: { keep: true } },
        [spec, { keep: true }],
      ]) {
        const io = fakeIO('win32')
        const text = JSON.stringify({ plugins: [entry] })
        io.files.set(
          `${directory}\\package.json`,
          JSON.stringify({ name: pkg }),
        )
        io.files.set('C:\\Users\\test\\.config\\opencode\\opencode.jsonc', text)
        const [write] = planOpenCodeRegistration(plugin(), '2', io)
        expect(write?.content).toBe(text)
        expect(write?.changed).toBe(false)
      }
    }
  })

  test('POSIX paths preserve case and decode URL escapes without using cwd', () => {
    for (const platform of ['linux', 'darwin']) {
      for (const spec of [
        '/Build/Local #@auth',
        'file:///Build/Local%20%23%40auth',
        '../../../../Build/Local #@auth',
      ]) {
        for (const entry of [spec, { package: spec }, [spec, { keep: true }]]) {
          const io = fakeIO(platform)
          io.cwd = '/unrelated'
          io.files.set(
            '/Build/Local #@auth/package.json',
            JSON.stringify({ name: pkg }),
          )
          const text = JSON.stringify({ plugin: [entry] })
          io.files.set('/home/test/.config/opencode/opencode.json', text)
          const [write] = planOpenCodeRegistration(plugin(), '2', io)
          expect(write?.content).toBe(text)
          expect(write?.changed).toBe(false)
        }
      }
    }
  })

  test('unreadable missing malformed and different local packages are not matches', () => {
    for (const manifest of [
      undefined,
      '{broken',
      'null',
      '[]',
      '{}',
      '{"name":42}',
      '{"name":"other"}',
      `{"name":"${pkg.toUpperCase()}"}`,
    ]) {
      const io = fakeIO()
      if (manifest !== undefined)
        io.files.set('/build/auth/package.json', manifest)
      io.files.set(
        '/home/test/.config/opencode/opencode.jsonc',
        '{"plugins":[{"package":"/build/auth"}]}',
      )
      const [write] = planOpenCodeRegistration(plugin(), '2', io)
      expect(write?.changed).toBe(true)
      expect(parse(write!.content).plugins).toEqual([
        { package: '/build/auth' },
        `${pkg}@1.2.3`,
      ])
    }
    const io = fakeIO()
    io.files.set(
      '/home/test/.config/opencode/opencode.jsonc',
      '{"plugins":["/private/auth"]}',
    )
    const read = io.fs!.readText
    io.fs!.readText = (file) => {
      if (file === '/private/auth/package.json') throw new Error('EACCES')
      return read(file)
    }
    expect(planOpenCodeRegistration(plugin(), '2', io)[0]?.changed).toBe(true)
  })

  test('invalid file URLs and nonlocal URLs never crash or match', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      for (const spec of [
        'file:///%ZZ',
        'file:///bad%2fpath',
        'https://example.com/auth',
        'file:///C:/bad%5cpath',
        'file:///no-drive',
      ]) {
        const io = fakeIO(platform)
        const text = JSON.stringify({
          plugins: [spec, { package: 42 }, null, {}],
        })
        const file =
          platform === 'win32'
            ? 'C:\\Users\\test\\.config\\opencode\\opencode.jsonc'
            : '/home/test/.config/opencode/opencode.jsonc'
        io.files.set(file, text)
        expect(planOpenCodeRegistration(plugin(), '2', io)[0]?.changed).toBe(
          true,
        )
      }
    }
  })

  test('real directory registrations leave config bytes unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'common-auth-local-plugin-'))
    roots.push(root)
    const config = join(root, 'config')
    const local = join(root, 'local build @dev')
    await mkdir(config)
    await mkdir(local)
    await writeFile(join(local, 'package.json'), JSON.stringify({ name: pkg }))
    for (const entry of [
      local,
      pathToFileURL(local).href,
      '../local build @dev',
    ]) {
      const text = JSON.stringify({ plugins: [{ package: entry }] })
      const file = join(config, 'opencode.jsonc')
      await writeFile(file, text)
      const writes = planOpenCodeRegistration(plugin(), '2', {
        env: { OPENCODE_CONFIG_DIR: config },
      })
      expect(writes[0]?.changed).toBe(false)
      await registerOpenCode(writes)
      expect(await readFile(file, 'utf8')).toBe(text)
    }
  })

  test('normal and dry runs report the existing entry and warn about npm duplicates', async () => {
    for (const dryRun of [false, true]) {
      for (const duplicate of [false, true]) {
        const io = fakeIO()
        io.files.set('/bin/opencode', '')
        io.files.set('/build/auth/package.json', JSON.stringify({ name: pkg }))
        const text = JSON.stringify({
          plugin: [{ package: '/build/auth', options: { flag: true } }],
          plugins: duplicate ? [`${pkg}@0.1`] : ['keep@1'],
        })
        io.files.set('/home/test/.config/opencode/opencode.jsonc', text)
        const term = terminal()
        await runSetup(
          plugin(),
          [
            '--yes',
            '--no-claustrum',
            '--host=opencode',
            '--opencode=2',
            ...(dryRun ? ['--dry-run'] : []),
          ],
          { ...io, terminal: term },
        )
        expect(io.files.get('/home/test/.config/opencode/opencode.jsonc')).toBe(
          text,
        )
        const output = term.lines.join('')
        expect(output).toContain(
          'already registered from {"package":"/build/auth","options":{"flag":true}}',
        )
        expect(output).not.toContain('Would write')
        expect(output.includes('may load twice')).toBe(duplicate)
        if (duplicate) {
          expect(output).toContain(`${pkg}@0.1`)
          expect(output).toContain('/build/auth')
        }
      }
    }
  })
})
