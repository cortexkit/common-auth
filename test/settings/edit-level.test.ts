import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { applySettingsEdits } from '../../src/settings/edit.js'
import {
  boolean,
  defineSettings,
  integer,
  list,
  openSettings,
  type SettingsEdit,
} from '../../src/settings/index.js'

const definition = defineSettings({
  plugin: 'example',
  settings: {
    enabled: {
      value: boolean(),
      default: false,
      hosts: 'both',
      overrides: { host: true, model: true },
    },
    plain: { value: boolean(), default: false, hosts: 'both' },
    model_only: {
      value: boolean(),
      default: false,
      hosts: 'both',
      overrides: { model: true },
    },
    empty_overrides: {
      value: boolean(),
      default: false,
      hosts: 'both',
      overrides: {},
    },
    floors: {
      value: list(integer()),
      default: [],
      hosts: 'both',
      overrides: { host: true },
    },
  },
})
const context = { host: 'pi', model: 'model-a' }

function update(source: string, edits: readonly SettingsEdit[]) {
  return applySettingsEdits(definition, source, edits, context)
}

test.each([
  [
    'pi',
    { default: false, opencode: false, 'model-a': false },
    { default: false, opencode: false, 'model-a': false, pi: true },
  ],
  [
    'opencode',
    { default: false, pi: false },
    { default: false, pi: false, opencode: true },
  ],
  [
    'pi',
    { default: false, pi: false, 'model-a': false },
    { default: false, pi: true, 'model-a': false },
  ],
  [
    'default',
    { pi: false, 'model-a': false },
    { pi: false, 'model-a': false, default: true },
  ],
  ['default', { default: false, pi: false }, { default: true, pi: false }],
  ['pi', false, { default: false, pi: true }],
  ['opencode', false, { default: false, opencode: true }],
  ['default', false, true],
  ['pi', undefined, { pi: true }],
  ['opencode', undefined, { opencode: true }],
  ['default', undefined, true],
] as const)('explicit %s writes from %j to %j', (level, initial, expected) => {
  const result = update(JSON.stringify({ enabled: initial }), [
    { setting: 'enabled', level, value: true },
  ])
  expect(result.outcome).toBe('updated')
  expect(parse(result.text)).toEqual({ enabled: expected })
})

test.each([
  [
    'pi',
    { default: false, pi: true, 'model-a': true },
    { default: false, 'model-a': true },
  ],
  ['opencode', { pi: true, opencode: false }, { pi: true }],
  ['default', { default: false, pi: true }, { pi: true }],
  ['pi', { pi: true }, undefined],
  ['default', { default: true }, undefined],
  ['default', false, undefined],
] as const)(
  'explicit %s removal from %j leaves %j',
  (level, initial, expected) => {
    const result = update(JSON.stringify({ enabled: initial }), [
      { setting: 'enabled', level, remove: true },
    ])
    expect(result.outcome).toBe('updated')
    expect(parse(result.text)).toEqual(
      expected === undefined ? {} : { enabled: expected },
    )
  },
)

test.each([
  ['pi', false],
  ['opencode', false],
  ['pi', undefined],
  ['default', undefined],
  ['opencode', { pi: true }],
] as const)('explicit %s removal from %j is unchanged', (level, initial) => {
  const source = JSON.stringify({ enabled: initial })
  expect(update(source, [{ setting: 'enabled', level, remove: true }])).toEqual(
    { outcome: 'unchanged', text: source, hasBom: false },
  )
})

test.each(['model_only', 'empty_overrides'])(
  'default is valid whenever %s declares overrides',
  (setting) => {
    const result = update('{}', [{ setting, level: 'default', value: true }])
    expect(parse(result.text)).toEqual({ [setting]: true })
  },
)

test('a host-only setting without default falls through to the declaration on other hosts', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'settings-level-'))
  const file = join(root, 'example.jsonc')
  try {
    await fs.writeFile(file, '{}')
    const settings = openSettings(definition, {
      file,
      separateInstall: false,
      log: { warn() {}, info() {} },
    })
    await settings.update(
      [{ setting: 'enabled', level: 'pi', value: true }],
      context,
    )
    expect(parse(await fs.readFile(file, 'utf8'))).toEqual({
      enabled: { pi: true },
    })
    expect(await settings.get('enabled', { host: 'pi' })).toBe(true)
    expect(await settings.get('enabled', { host: 'opencode' })).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test.each([
  { setting: 'plain', level: 'pi', value: true },
  { setting: 'plain', level: 'opencode', value: true },
  { setting: 'plain', level: 'default', value: true },
  { setting: 'model_only', level: 'pi', value: true },
  { setting: 'model_only', level: 'opencode', remove: true },
  { setting: 'empty_overrides', level: 'pi', value: true },
  { setting: 'enabled', level: 'default', path: [], value: true },
  { setting: 'enabled', level: 'pi', path: [], remove: true },
  {
    setting: 'enabled',
    level: 'model-a' as SettingsEdit['level'],
    value: true,
  },
  { setting: 'enabled', level: 'pi', value: { default: false, pi: true } },
  { setting: 'enabled', level: 'pi', value: 'yes' },
] satisfies SettingsEdit[])(
  'invalid explicit-level edit %j refuses the entire write',
  async (invalid) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'settings-level-'))
    const file = join(root, 'example.jsonc')
    const source = '{ /* keep */ "enabled": false }\n'
    try {
      await fs.writeFile(file, source)
      const settings = openSettings(definition, {
        file,
        separateInstall: false,
        log: { warn() {}, info() {} },
      })
      await expect(
        settings.update(
          [{ setting: 'enabled', value: true }, invalid],
          context,
        ),
      ).rejects.toMatchObject({
        name: 'SettingsRefusal',
        code: 'settings-invalid-value',
      })
      expect(await fs.readFile(file, 'utf8')).toBe(source)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test('plain-to-override conversion preserves surrounding and nested list comments', () => {
  const source =
    '{\n  // before\n  "floors": [\n    1, // first\n    /* second */ 2\n  ], // after\n  "unknown": 7\n}\n'
  const result = update(source, [
    { setting: 'floors', level: 'pi', value: [3] },
  ])
  expect(parse(result.text)).toEqual({
    floors: { default: [1, 2], pi: [3] },
    unknown: 7,
  })
  for (const comment of ['// before', '// first', '/* second */', '// after']) {
    expect(result.text.split(comment)).toHaveLength(2)
  }
  expect(result.text).toContain('"unknown": 7')
})

test('without level a host edit still overwrites a plain value', () => {
  const source = '{ /* keep */ "enabled": false }'
  const result = update(source, [{ setting: 'enabled', value: true }])
  expect(result.text).toBe(source.replace('false', 'true'))
  expect(parse(result.text)).toEqual({ enabled: true })
})

test('explicit levels and implicit context destinations follow earlier edits in order', () => {
  const result = update('{"enabled":false}', [
    { setting: 'enabled', level: 'pi', value: true },
    { setting: 'enabled', value: false },
    { setting: 'enabled', level: 'opencode', value: true },
    { setting: 'enabled', level: 'default', value: true },
  ])
  expect(parse(result.text)).toEqual({
    enabled: { default: true, pi: false, opencode: true },
  })
})

test.each(['{}', '{"enabled":false}'])(
  'a default removal followed by host creation on %s validates the new host member',
  (source) => {
    const result = update(source, [
      { setting: 'enabled', level: 'default', remove: true },
      { setting: 'enabled', level: 'pi', value: true },
    ])
    expect(parse(result.text)).toEqual({ enabled: { pi: true } })
  },
)

test('a missing-file plan recreates distinct default and host protection in order', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'settings-level-'))
  const file = join(root, 'example.jsonc')
  try {
    const settings = openSettings(definition, {
      file,
      separateInstall: false,
      createMissing: true,
      log: { warn() {}, info() {} },
    })
    expect(
      await settings.update((current) => {
        expect(current).toEqual({ status: 'missing' })
        return [
          { setting: 'enabled', level: 'default', value: false },
          { setting: 'enabled', level: 'pi', value: true },
        ]
      }, context),
    ).toEqual({ outcome: 'updated' })
    expect(parse(await fs.readFile(file, 'utf8'))).toEqual({
      schema_version: 1,
      enabled: { default: false, pi: true },
    })
    expect(await settings.get('enabled', { host: 'pi' })).toBe(true)
    expect(await settings.get('enabled', { host: 'opencode' })).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
