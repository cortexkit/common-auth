import { describe, expect, expectTypeOf, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as Settings from '@cortexkit/common-auth/settings'
import type {
  SettingDeclaration,
  SettingsDefinition,
} from '../../src/settings/define.js'
import type {
  ValueDescriptor,
  ValueOf,
} from '../../src/settings/descriptors.js'
import type { SettingsEdit, UpdateResult } from '../../src/settings/edit.js'
import type {
  LegacyProjectSource,
  OpenSettingsOptions,
  SettingsHandle,
} from '../../src/settings/handle.js'
import type {
  LegacySource,
  MapResult,
  MoveOptions,
  MoveOutcome,
  MoveResult,
  MoveSource,
} from '../../src/settings/move.js'
import type { SettingsRefusalCode } from '../../src/settings/refusal.js'
import type { GetOptions } from '../../src/settings/resolve.js'
import type { ReportEntry, ReportReason } from '../../src/settings/snapshot.js'

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

describe('settings package', () => {
  test('maps the settings subpath to built entrypoints', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    expect(manifest.exports['./settings']).toEqual({
      types: './dist/settings/index.d.ts',
      import: './dist/settings/index.js',
    })
    expect(import.meta.resolve('@cortexkit/common-auth/settings')).toBe(
      new URL('../../dist/settings/index.js', import.meta.url).href,
    )
  })

  test('built settings entrypoint exposes only the public runtime exports', async () => {
    // Build first so this loads dist/settings/index.js, not src/settings/index.ts.
    const settings = await import('@cortexkit/common-auth/settings')
    expect(Object.keys(settings).sort()).toEqual(
      [
        'cortexkitConfigDir',
        'settingsFilePath',
        'isAbsoluteForPlatform',
        'defineSettings',
        'openSettings',
        'moveSettingsOnce',
        'settingsJsonSchema',
        'boolean',
        'integer',
        'number',
        'string',
        'oneOf',
        'list',
        'object',
        'record',
        'SettingsRefusal',
        'SETTINGS_REFUSAL_CODES',
      ].sort(),
    )
    const { SETTINGS_REFUSAL_CODES, ...functions } = settings
    for (const [name, value] of Object.entries(functions)) {
      expect({ name, type: typeof value }).toEqual({ name, type: 'function' })
    }
    expect(SETTINGS_REFUSAL_CODES).toEqual([
      'settings-unparseable',
      'settings-newer-version',
      'settings-invalid-value',
      'settings-busy',
      'settings-unavailable',
    ])
    expect(Object.isFrozen(SETTINGS_REFUSAL_CODES)).toBe(true)
  })

  test('exports every public settings type through the built declarations', () => {
    expectTypeOf<Settings.ValueDescriptor>().toEqualTypeOf<ValueDescriptor>()
    expectTypeOf<
      Settings.ValueOf<{ kind: 'oneOf'; values: readonly ['a', 'b'] }>
    >().toEqualTypeOf<ValueOf<{ kind: 'oneOf'; values: readonly ['a', 'b'] }>>()
    expectTypeOf<Settings.SettingDeclaration>().toEqualTypeOf<SettingDeclaration>()
    expectTypeOf<Settings.SettingsDefinition>().toEqualTypeOf<SettingsDefinition>()
    expectTypeOf<Settings.OpenSettingsOptions>().toEqualTypeOf<OpenSettingsOptions>()
    expectTypeOf<Settings.SettingsHandle>().toEqualTypeOf<SettingsHandle>()
    expectTypeOf<Settings.GetOptions>().toEqualTypeOf<GetOptions>()
    expectTypeOf<Settings.ReportEntry>().toEqualTypeOf<ReportEntry>()
    expectTypeOf<Settings.ReportReason>().toEqualTypeOf<ReportReason>()
    expectTypeOf<Settings.LegacyProjectSource>().toEqualTypeOf<LegacyProjectSource>()
    expectTypeOf<Settings.SettingsEdit>().toEqualTypeOf<SettingsEdit>()
    expectTypeOf<Settings.UpdateResult>().toEqualTypeOf<UpdateResult>()
    expectTypeOf<Settings.SettingsRefusalCode>().toEqualTypeOf<SettingsRefusalCode>()
    expectTypeOf<Settings.MoveOptions>().toEqualTypeOf<MoveOptions>()
    expectTypeOf<Settings.MoveSource>().toEqualTypeOf<MoveSource>()
    expectTypeOf<Settings.LegacySource>().toEqualTypeOf<LegacySource>()
    expectTypeOf<Settings.MapResult>().toEqualTypeOf<MapResult>()
    expectTypeOf<Settings.MoveResult>().toEqualTypeOf<MoveResult>()
    expectTypeOf<Settings.MoveOutcome>().toEqualTypeOf<MoveOutcome>()
  })

  test('settings sources never read the environment or call homedir', async () => {
    const root = fileURLToPath(new URL('../../src/settings/', import.meta.url))
    const files = await sourceFiles(root)
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (/\bprocess\s*\.\s*env\b|\bhomedir\s*\(/.test(source)) {
        violations.push(relative(root, file))
      }
    }
    expect(violations).toEqual([])
  })
})
