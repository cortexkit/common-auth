import { describe, expect, expectTypeOf, test } from 'bun:test'
import { defineSettings } from '../../src/settings/define.js'
import {
  boolean,
  integer,
  list,
  object,
  record,
  string,
} from '../../src/settings/descriptors.js'
import { parseSettings } from '../../src/settings/parse.js'
import {
  buildSettingsSnapshot,
  type ReportEntry,
  type ReportReason,
} from '../../src/settings/snapshot.js'

const definition = defineSettings({
  plugin: 'example',
  settings: {
    x: { value: integer(), default: 10, hosts: 'both', project: 'allowed' },
    wait: {
      value: integer({ min: 0 }),
      default: 15,
      hosts: 'both',
      overrides: { host: true },
      project: 'allowed',
    },
    model_wait: {
      value: integer(),
      default: 15,
      hosts: 'both',
      overrides: { model: true },
    },
    private_value: { value: string(), default: 'private', hosts: 'both' },
    constructor: { value: integer(), default: 7, hosts: 'both' },
    sidebar: {
      value: object({
        collapsed: boolean(),
        nested: object({ width: integer(), label: string() }),
      }),
      default: { collapsed: false, nested: { width: 10, label: 'default' } },
      hosts: 'both',
      project: 'allowed',
    },
    rows: {
      value: list(object({ name: string(), size: integer() })),
      default: [],
      hosts: 'both',
    },
    limits: {
      value: record(object({ max: integer(), min: integer() })),
      default: {},
      hosts: 'both',
    },
  },
})

const user: ReportEntry['file'] = { kind: 'user', path: '/test/settings.jsonc' }
const entry = (
  keyPath: string[],
  reason: ReportReason,
  file = user,
): ReportEntry => ({
  file,
  keyPath,
  reason,
})
const snapshot = (text: string, file = user) =>
  buildSettingsSnapshot(definition, file, parseSettings(text))

describe('settings snapshots', () => {
  test('ReportReason is exactly the nine report reasons', () => {
    expectTypeOf<ReportReason>().toEqualTypeOf<
      | 'unknown-key'
      | 'override-not-allowed'
      | 'user-only-in-project'
      | 'invalid-value'
      | 'invalid-schema-version'
      | 'newer-version-key-ignored'
      | 'duplicate-key'
      | 'unparseable'
      | 'unreadable'
    >()
  })

  test('accepts JSONC and a leading BOM without reporting either', () => {
    const result = snapshot('\uFEFF// user settings\n{"x": 2,}')
    expect(result.settings).toEqual({ x: 2 })
    expect(result.entries).toEqual([])
    expect(result.parsed.hasBom).toBe(true)
    expect(result.hasDuplicates).toBe(false)
  })

  test.each(['', ' \t\r\n'])(
    'empty or whitespace text is an empty snapshot: %j',
    (text) => {
      const result = snapshot(text)
      expect(result.settings).toEqual({})
      expect(result.entries).toEqual([])
      expect(result.schemaVersion).toBe(1)
    },
  )

  test.each(['[]', '5', 'null', '{"x": 2, bad}', '\uFEFF\uFEFF{}'])(
    'reports unparseable files at the root: %s',
    (text) => {
      const result = snapshot(text)
      expect(result.settings).toEqual({})
      expect(result.entries).toEqual([entry([], 'unparseable')])
    },
  )

  test('missing schema_version reads as 1, and $schema is ignored', () => {
    const result = snapshot('{"$schema": "editor.json", "x": 2}')
    expect(result.schemaVersion).toBe(1)
    expect(result.newer).toBe(false)
    expect(result.settings).toEqual({ x: 2 })
    expect(result.entries).toEqual([])
  })

  test.each(['1.5', '0', '-1', '"2"', 'null', '{}', 'true'])(
    'invalid schema_version %s is reported and reads as 1',
    (version) => {
      const result = snapshot(`{"schema_version": ${version}, "x": 2}`)
      expect(result.schemaVersion).toBe(1)
      expect(result.newer).toBe(false)
      expect(result.settings).toEqual({ x: 2 })
      expect(result.entries).toEqual([
        entry(['schema_version'], 'invalid-schema-version'),
      ])
    },
  )

  test('the current schema_version is accepted', () => {
    const result = snapshot('{"schema_version": 1}')
    expect(result.schemaVersion).toBe(1)
    expect(result.newer).toBe(false)
    expect(result.entries).toEqual([])
  })

  test('newer versions apply known keys and report unknown keys at every descriptor depth', () => {
    const result = snapshot(`{
      "schema_version": 2, "x": 3, "future": true,
      "sidebar": {"collapsed": "yes", "nested": {"width": 4, "future": 1}},
      "rows": [{"name": "a", "size": 1, "extra": 2}],
      "limits": {"a": {"max": 1, "min": 0, "note": "x"}},
      "wait": {"pi": "invalid", "default": 5, "model": 1}
    }`)
    expect(result.schemaVersion).toBe(2)
    expect(result.newer).toBe(true)
    expect(result.settings).toEqual({
      x: 3,
      sidebar: { nested: { width: 4 } },
      rows: [{ name: 'a', size: 1 }],
      limits: { a: { max: 1, min: 0 } },
      wait: { default: 5 },
    })
    expect(result.entries).toEqual([
      entry(['future'], 'newer-version-key-ignored'),
      entry(['sidebar', 'collapsed'], 'invalid-value'),
      entry(['sidebar', 'nested', 'future'], 'newer-version-key-ignored'),
      entry(['rows', '0', 'extra'], 'newer-version-key-ignored'),
      entry(['limits', 'a', 'note'], 'newer-version-key-ignored'),
      entry(['wait', 'pi'], 'invalid-value'),
      entry(['wait', 'model'], 'override-not-allowed'),
    ])
  })

  test('a top-level __proto__ is unknown and changes no known value or prototype', () => {
    const result = snapshot('{"__proto__": {"x": 1}, "x": 2}')
    expect(result.entries).toEqual([entry(['__proto__'], 'unknown-key')])
    expect(result.settings).toEqual({ x: 2 })
    expect(Object.getPrototypeOf(result.settings)).toBe(Object.prototype)
    expect(Object.hasOwn(result.settings, '__proto__')).toBe(false)
  })

  test('an absent constructor setting has no inherited value or report', () => {
    const result = snapshot('{}')
    expect(Object.hasOwn(result.settings, 'constructor')).toBe(false)
    expect(definition.settings.constructor.default).toBe(7)
    expect(result.entries).toEqual([])
  })

  test('record keys named __proto__ are ordinary keys and unknown fields are removed', () => {
    const result = snapshot(
      '{"limits": {"__proto__": {"max": 1, "min": 0, "note": "x"}}}',
    )
    expect(result.entries).toEqual([
      entry(['limits', '__proto__', 'note'], 'unknown-key'),
    ])
    const limits = result.settings.limits as Record<string, unknown>
    expect(Object.hasOwn(limits, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(limits, '__proto__')?.value).toEqual(
      { max: 1, min: 0 },
    )
    expect(Object.getPrototypeOf(limits)).toBe(Object.prototype)
  })

  test.each([
    ['{"x": 1, "x": 2, "x": 3}', { x: 3 }, ['x']],
    [
      '{"wait": {"default": 15, "pi": 1, "pi": 0}}',
      { wait: { default: 15, pi: 0 } },
      ['wait', 'pi'],
    ],
  ])(
    'duplicate keys use the last value and report once: %s',
    (text, settings, path) => {
      const result = snapshot(text as string)
      expect(result.settings).toEqual(settings)
      expect(result.entries).toEqual([entry(path as string[], 'duplicate-key')])
      expect(result.hasDuplicates).toBe(true)
    },
  )

  test('duplicates in overwritten objects are still recorded for write refusal', () => {
    const result = snapshot(
      '{"wait": {"pi": 1, "pi": 2}, "wait": {"default": 3}}',
    )
    expect(result.settings).toEqual({ wait: { default: 3 } })
    expect(result.entries).toEqual([
      entry(['wait', 'pi'], 'duplicate-key'),
      entry(['wait'], 'duplicate-key'),
    ])
    expect(result.hasDuplicates).toBe(true)
  })

  test('an invalid pi override is reported before any host is resolved', () => {
    const result = snapshot(
      '{"wait": {"default": 15, "pi": "bad", "opencode": 0}}',
    )
    expect(result.settings).toEqual({ wait: { default: 15, opencode: 0 } })
    expect(result.entries).toEqual([entry(['wait', 'pi'], 'invalid-value')])
  })

  test('zero is a valid host override', () => {
    const result = snapshot('{"wait": {"default": 15, "pi": 0}}')
    expect(result.settings).toEqual({ wait: { default: 15, pi: 0 } })
    expect(result.entries).toEqual([])
  })

  test('an object on a non-object setting without overrides has one reason at the setting', () => {
    const result = snapshot('{"x": {"default": 15}}')
    expect(result.settings).toEqual({})
    expect(result.entries).toEqual([entry(['x'], 'override-not-allowed')])
  })

  test('disallowed override keys are skipped while allowed keys still apply', () => {
    const result = snapshot('{"wait": {"default": 15, "pi": 0, "model/id": 2}}')
    expect(result.settings).toEqual({ wait: { default: 15, pi: 0 } })
    expect(result.entries).toEqual([
      entry(['wait', 'model/id'], 'override-not-allowed'),
    ])
  })

  test('model-only overrides exclude host names and preserve arbitrary model ids', () => {
    const result = snapshot(
      '{"model_wait": {"default": 1, "pi": 2, "opencode": 3, "constructor": 4, "__proto__": 5}}',
    )
    const values = result.settings.model_wait as Record<string, unknown>
    expect(values.default).toBe(1)
    expect(Object.hasOwn(values, 'constructor')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(values, 'constructor')?.value).toBe(
      4,
    )
    expect(Object.hasOwn(values, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(values, '__proto__')?.value).toBe(5)
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype)
    expect(result.entries).toEqual([
      entry(['model_wait', 'pi'], 'override-not-allowed'),
      entry(['model_wait', 'opencode'], 'override-not-allowed'),
    ])
  })

  test.each(['project', 'legacy-project'] as const)(
    'user-only values are skipped in a %s file with its file identity',
    (kind) => {
      const file = { kind, path: '/test/project/settings.jsonc' }
      const result = snapshot('{"private_value": "public", "x": 2}', file)
      expect(result.file).toEqual(file)
      expect(result.settings).toEqual({ x: 2 })
      expect(result.entries).toEqual([
        entry(['private_value'], 'user-only-in-project', file),
      ])
    },
  )

  test('a user file accepts user-only settings', () => {
    const result = snapshot('{"private_value": "chosen"}')
    expect(result.settings).toEqual({ private_value: 'chosen' })
    expect(result.entries).toEqual([])
  })

  test('partial objects keep valid fields and report invalid or unknown fields at their full paths', () => {
    const result = snapshot(`{"sidebar": {
      "collapsed": "yes", "extra": 1,
      "nested": {"width": 3, "label": 5, "constructor": 1}
    }}`)
    expect(result.settings).toEqual({ sidebar: { nested: { width: 3 } } })
    expect(result.entries).toEqual([
      entry(['sidebar', 'collapsed'], 'invalid-value'),
      entry(['sidebar', 'extra'], 'unknown-key'),
      entry(['sidebar', 'nested', 'label'], 'invalid-value'),
      entry(['sidebar', 'nested', 'constructor'], 'unknown-key'),
    ])
  })

  test('missing fields are valid for partial objects, including nested objects', () => {
    const result = snapshot('{"sidebar": {"nested": {"width": 3}}}')
    expect(result.settings).toEqual({ sidebar: { nested: { width: 3 } } })
    expect(result.entries).toEqual([])
  })

  test('invalid whole values are skipped without affecting valid siblings', () => {
    const result = snapshot('{"x": 1.5, "sidebar": 5, "private_value": "ok"}')
    expect(result.settings).toEqual({ private_value: 'ok' })
    expect(result.entries).toEqual([
      entry(['x'], 'invalid-value'),
      entry(['sidebar'], 'invalid-value'),
    ])
  })

  test('unknown fields in list objects are dropped, with decimal index paths', () => {
    const result = snapshot('{"rows": [{"name": "a", "size": 2, "extra": 1}]}')
    expect(result.settings).toEqual({ rows: [{ name: 'a', size: 2 }] })
    expect(result.entries).toEqual([
      entry(['rows', '0', 'extra'], 'unknown-key'),
    ])
  })

  test('lists require complete objects and validate every item before skipping the whole list', () => {
    const result = snapshot(
      '{"rows": [{"name": "a"}, {"name": false, "size": 2}]}',
    )
    expect(result.settings).toEqual({})
    expect(result.entries).toEqual([
      entry(['rows', '0', 'size'], 'invalid-value'),
      entry(['rows', '1', 'name'], 'invalid-value'),
    ])
  })

  test('record objects are complete and one invalid entry skips the whole record', () => {
    const result = snapshot(
      '{"limits": {"a": {"max": 1}, "b": {"max": 2, "min": 0}}}',
    )
    expect(result.settings).toEqual({})
    expect(result.entries).toEqual([
      entry(['limits', 'a', 'min'], 'invalid-value'),
    ])
  })

  test('unknown fields in record objects are dropped without invalidating their values', () => {
    const result = snapshot(
      '{"limits": {"a": {"max": 1, "min": 0, "note": "x"}}}',
    )
    expect(result.settings).toEqual({ limits: { a: { max: 1, min: 0 } } })
    expect(result.entries).toEqual([
      entry(['limits', 'a', 'note'], 'unknown-key'),
    ])
  })
})
