import { describe, expect, expectTypeOf, test } from 'bun:test'
import { applyEdits, modify } from 'jsonc-parser'
import { defineSettings } from '../../src/settings/define.js'
import {
  boolean,
  integer,
  list,
  object,
  record,
  string,
} from '../../src/settings/descriptors.js'
import {
  applySettingsEdits,
  type SettingsEdit,
  type UpdateResult,
} from '../../src/settings/edit.js'
import { parseSettings } from '../../src/settings/parse.js'
import { SettingsRefusal } from '../../src/settings/refusal.js'

const definition = defineSettings({
  plugin: 'example',
  settings: {
    x: { value: integer(), default: 1, hosts: 'both' },
    y: { value: integer(), default: 2, hosts: 'both' },
    z: { value: integer(), default: 3, hosts: 'both' },
    wait: {
      value: integer(),
      default: 1,
      hosts: 'both',
      overrides: { host: true, model: true },
    },
    host_only: {
      value: integer(),
      default: 1,
      hosts: 'both',
      overrides: { host: true },
    },
    model_only: {
      value: integer(),
      default: 1,
      hosts: 'both',
      overrides: { model: true },
    },
    sidebar: {
      value: object({
        width: integer({ min: 0 }),
        collapsed: boolean(),
        nested: object({ label: string(), size: integer() }),
        rows: list(object({ max: integer(), min: integer() })),
        limits: record(object({ max: integer(), min: integer() })),
      }),
      default: {
        width: 10,
        collapsed: false,
        nested: { label: '', size: 1 },
        rows: [],
        limits: {},
      },
      hosts: 'both',
    },
    limits: {
      value: record(object({ max: integer(), min: integer() })),
      default: {},
      hosts: 'both',
    },
    labels: { value: record(string()), default: {}, hosts: 'both' },
    rows: { value: list(integer()), default: [], hosts: 'both' },
    constructor: { value: integer(), default: 1, hosts: 'both' },
  },
})

const update = (
  source: string,
  edits: readonly SettingsEdit[],
  context = { host: 'pi' } as { host: string; model?: string },
) => applySettingsEdits(definition, source, edits, context)

function value(text: string) {
  const parsed = parseSettings(text)
  expect(parsed.parseable).toBe(true)
  if (!parsed.parseable) throw new Error('Expected valid edited JSONC')
  expect(parsed.hasDuplicates).toBe(false)
  return parsed.value
}

function refuses(source: string, edits: readonly SettingsEdit[]) {
  try {
    update(source, edits)
    throw new Error('Expected the whole edit batch to be refused')
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsRefusal)
    expect((error as SettingsRefusal).code).toBe('settings-invalid-value')
  }
}

describe('settings edit validation', () => {
  test('SettingsEdit is a value or removal and UpdateResult has two outcomes', () => {
    expectTypeOf<SettingsEdit>().toEqualTypeOf<
      {
        setting: string
        path?: readonly string[]
        level?: 'default' | 'opencode' | 'pi'
      } & ({ value: unknown; remove?: never } | { remove: true; value?: never })
    >()
    expectTypeOf<UpdateResult>().toEqualTypeOf<{
      outcome: 'updated' | 'unchanged'
    }>()
  })

  test.each([
    { setting: 'unknown', value: 1 },
    { setting: 'toString', value: 1 },
    { setting: 'x', path: [], value: 1 },
    { setting: 'x', path: ['field'], remove: true },
    { setting: 'rows', path: ['0'], value: 1 },
    { setting: 'sidebar', path: ['unknown'], value: 1 },
    { setting: 'sidebar', path: ['nested', 'unknown'], remove: true },
    { setting: 'sidebar', path: ['width', 'other'], value: 1 },
    { setting: 'sidebar', path: ['collapsed'], value: 'yes' },
    { setting: 'sidebar', path: ['width'], value: -1 },
    { setting: 'x', value: 1.5 },
    { setting: 'wait', value: { pi: 3 } },
    { setting: 'sidebar', value: { extra: 1 } },
    { setting: 'limits', value: { a: { max: 1 } } },
  ] satisfies SettingsEdit[])('refuses the whole batch for %j', (edit) => {
    const source = '{"x": 1}'
    refuses(source, [{ setting: 'x', value: 2 }, edit])
  })

  test('validates all edits before trying a working-copy path check', () => {
    const source = '{"sidebar":5}'
    const edits: SettingsEdit[] = [
      { setting: 'sidebar', path: ['width'], value: 3 },
      {
        setting: 'x',
        get value(): unknown {
          throw new Error('validated last edit')
        },
      },
    ]
    expect(() => update(source, edits)).toThrow('validated last edit')
  })

  test.each([
    '{"sidebar":5}',
    '{"sidebar":null}',
    '{"sidebar":[]}',
    '{"sidebar":{"nested":5}}',
    '{"sidebar":{"nested":false}}',
    '{"sidebar":{"nested":[]}}',
  ])('rejects a present non-object path prefix in %s', (source) => {
    refuses(source, [
      { setting: 'sidebar', path: ['nested', 'label'], value: 'new' },
    ])
    refuses(source, [
      { setting: 'sidebar', path: ['nested', 'label'], remove: true },
    ])
  })

  test('path checks use earlier edits rather than the starting value', () => {
    const result = update('{"sidebar":5}', [
      { setting: 'sidebar', value: {} },
      { setting: 'sidebar', path: ['nested', 'label'], value: 'new' },
    ])
    expect(value(result.text)).toEqual({
      sidebar: { nested: { label: 'new' } },
    })
  })
})

describe('settings edit destinations and order', () => {
  test.each([
    [
      'wait',
      { host: 'pi', model: 'vendor/model' },
      { default: 1, pi: 2, 'vendor/model': 3 },
      { default: 1, pi: 2, 'vendor/model': 9 },
    ],
    ['wait', { host: 'pi' }, { default: 1, pi: 2 }, { default: 1, pi: 9 }],
    ['wait', { host: 'pi' }, { default: 1, pi: 'bad' }, { default: 1, pi: 9 }],
    [
      'wait',
      { host: 'opencode' },
      { default: 1, opencode: 2, pi: 3 },
      { default: 1, opencode: 9, pi: 3 },
    ],
    [
      'host_only',
      { host: 'pi', model: 'vendor/model' },
      { default: 1, 'vendor/model': 2 },
      { default: 9, 'vendor/model': 2 },
    ],
    [
      'host_only',
      { host: 'pi', model: 'vendor/model' },
      { default: 1, pi: 2, 'vendor/model': 3 },
      { default: 1, pi: 9, 'vendor/model': 3 },
    ],
    [
      'model_only',
      { host: 'pi' },
      { default: 1, pi: 2 },
      { default: 9, pi: 2 },
    ],
    [
      'wait',
      { host: 'other', model: 'missing' },
      { default: 1, pi: 2 },
      { default: 9, pi: 2 },
    ],
    [
      'wait',
      { host: 'other', model: 'pi' },
      { default: 1, pi: 2 },
      { default: 9, pi: 2 },
    ],
    [
      'wait',
      { host: 'other', model: 'opencode' },
      { default: 1, opencode: 2 },
      { default: 9, opencode: 2 },
    ],
    [
      'model_only',
      { host: 'pi', model: 'default' },
      { default: 1, pi: 2 },
      { default: 9, pi: 2 },
    ],
    ['wait', { host: 'pi', model: 'vendor/model' }, 1, 9],
  ] as const)(
    'edits %s at the permitted existing destination with %j',
    (setting, context, initial, expected) => {
      const result = update(
        JSON.stringify({ [setting]: initial }),
        [{ setting, value: 9 }],
        context,
      )
      expect(value(result.text)).toEqual({ [setting]: expected })
    },
  )

  test.each([
    [{ default: 1, pi: 2 }, { host: 'pi' }, { default: 1 }],
    [{ default: 1 }, { host: 'pi' }, undefined],
    [{ pi: 2 }, { host: 'pi' }, undefined],
    [
      { default: 1, pi: 2, 'vendor/model': 3 },
      { host: 'pi', model: 'vendor/model' },
      { default: 1, pi: 2 },
    ],
    [{ pi: 2 }, { host: 'other' }, { pi: 2 }],
    [{}, { host: 'pi' }, {}],
    [1, { host: 'pi' }, undefined],
  ] as const)(
    'removes one destination from %j using %j',
    (initial, context, expected) => {
      const source = JSON.stringify({ wait: initial })
      const result = update(
        source,
        [{ setting: 'wait', remove: true }],
        context,
      )
      expect(value(result.text)).toEqual(
        expected === undefined ? {} : { wait: expected },
      )
      if (expected === initial)
        expect(result).toEqual({
          outcome: 'unchanged',
          text: source,
          hasBom: false,
        })
    },
  )

  test('later edits choose a new destination after removal', () => {
    const result = update('{"wait":{"default":1,"pi":2}}', [
      { setting: 'wait', remove: true },
      { setting: 'wait', value: 3 },
    ])
    expect(value(result.text)).toEqual({ wait: { default: 3 } })
  })

  test('remove then set a field recreates only that field', () => {
    const result = update('{"sidebar":{"width":20,"collapsed":false}}', [
      { setting: 'sidebar', remove: true },
      { setting: 'sidebar', path: ['collapsed'], value: true },
    ])
    expect(value(result.text)).toEqual({ sidebar: { collapsed: true } })
  })

  test('an absent plain setting or path removal is unchanged', () => {
    const source = '{ /* keep */ "sidebar":{} }'
    expect(
      update(source, [
        { setting: 'x', remove: true },
        { setting: 'sidebar', path: ['collapsed'], remove: true },
      ]),
    ).toEqual({ outcome: 'unchanged', text: source, hasBom: false })
  })
})

describe('settings JSONC preservation', () => {
  test.each(['x', 'y', 'z'])(
    'removing %s keeps the comment lines above and below byte-identical',
    (setting) => {
      const source =
        '{\r\n  // above x\r\n  "x": 1,\r\n  /* below x */\r\n  // above y\r\n  "y": 2,\r\n  /* below y */\r\n  // above z\r\n  "z": 3\r\n  /* below z */\r\n}'
      const expected = source
        .replace(
          `  "${setting}": ${{ x: 1, y: 2, z: 3 }[setting]}${setting === 'z' ? '' : ','}\r\n`,
          '',
        )
        .replace(setting === 'z' ? '"y": 2,' : 'never matched', '"y": 2')
      const result = update(source, [{ setting, remove: true }])
      expect(result.text).toBe(expected)
      expect(value(result.text)).toEqual(
        Object.fromEntries(
          Object.entries({ x: 1, y: 2, z: 3 }).filter(
            ([key]) => key !== setting,
          ),
        ),
      )
    },
  )

  test.each(['// own comment', '/* own comment */', '/* own\ncomment */'])(
    'removes a same-line trailing comment %s',
    (comment) => {
      const source = `{\n  // before\n  "x": 1, ${comment}\n  // after\n  "y": 2\n}`
      const result = update(source, [{ setting: 'x', remove: true }])
      expect(result.text).toBe('{\n  // before\n  // after\n  "y": 2\n}')
      expect(value(result.text)).toEqual({ y: 2 })
    },
  )

  test('removes the only member but keeps comments inside the empty object', () => {
    const source = '{\n  // before\n  "x": 1 // own\n  /* after */\n}'
    const result = update(source, [{ setting: 'x', remove: true }])
    expect(result.text).toBe('{\n  // before\n  /* after */\n}')
    expect(value(result.text)).toEqual({})
  })

  test.each([
    ['{"x":1,"y":2}', 'x', '{"y":2}'],
    ['{"x":1,"y":2}', 'y', '{"x":1}'],
    ['{"x":1}', 'x', '{}'],
    ['{"x":1,}', 'x', '{}'],
    [
      '{\n "x":1,\n // keep\n "y":2, // own\n // after\n}',
      'y',
      '{\n "x":1,\n // keep\n // after\n}',
    ],
    [
      '{\n "x":1\n // keep\n ,\n "y":2\n // after\n}',
      'x',
      '{\n // keep\n \n "y":2\n // after\n}',
    ],
  ])(
    'removes compact or trailing-comma member in %s',
    (source, setting, expected) => {
      const result = update(source, [{ setting, remove: true }])
      expect(result.text).toBe(expected)
      const original = value(source)
      delete original[setting]
      expect(value(result.text)).toEqual(original)
    },
  )

  test('field edits preserve comments and unknown fields inside the object', () => {
    const source =
      '{\n  // outside\n  "sidebar": {\n    // width\n    "width": 10,\n    /* sibling */\n    "extra": 7\n  },\n  "unknown": 8\n}'
    const result = update(source, [
      { setting: 'sidebar', path: ['width'], value: 20 },
    ])
    expect(result.text).toBe(source.replace('"width": 10', '"width": 20'))
    expect(value(result.text)).toEqual({
      sidebar: { width: 20, extra: 7 },
      unknown: 8,
    })
  })

  test('record path edits keep other keys and their comments', () => {
    const source =
      '{"labels": {\n  // a\n  "a": "old",\n  // b\n  "b": "keep"\n}}'
    const result = update(source, [
      { setting: 'labels', path: ['a'], value: 'new' },
    ])
    expect(result.text).toBe(source.replace('"old"', '"new"'))
    expect(value(result.text)).toEqual({ labels: { a: 'new', b: 'keep' } })
  })

  test('whole object replacement drops only inner comments and unknown fields', () => {
    const source =
      '{\n  // outside before\n  "sidebar": { /* inner */ "width": 10, "extra": 7 },\n  // outside after\n  "unknown": 8\n}'
    const result = update(source, [
      { setting: 'sidebar', value: { collapsed: true } },
    ])
    expect(result.text).not.toContain('inner')
    expect(result.text).not.toContain('extra')
    expect(result.text).toContain('  // outside before\n')
    expect(result.text).toContain('  // outside after\n')
    expect(value(result.text)).toEqual({
      sidebar: { collapsed: true },
      unknown: 8,
    })
  })

  test('insertions use jsonc-parser modify formatting with two-space indentation', () => {
    const source = '{\n  // existing\n  "x": 1\n}'
    const result = update(source, [
      { setting: 'sidebar', path: ['width'], value: 3 },
    ])
    expect(result.text).toBe(
      applyEdits(
        source,
        modify(source, ['sidebar', 'width'], 3, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      ),
    )
    expect(value(result.text)).toEqual({ x: 1, sidebar: { width: 3 } })
  })
})

describe('settings equality and final resolution units', () => {
  test.each([
    ['{"x":1}', '{"x":1}', false],
    ['{ "x" :  1e0 }', '{ "x" :  1e0 }', false],
    ['\uFEFF{\r\n "x":1.0\r\n}', '{\r\n "x":1.0\r\n}', true],
  ] as const)(
    'a net-equal batch preserves original bytes in %s',
    (source, text, hasBom) => {
      expect(
        update(source, [
          { setting: 'x', value: 2 },
          { setting: 'x', value: 1 },
        ]),
      ).toEqual({ outcome: 'unchanged', text, hasBom })
      expect(update(source, [{ setting: 'x', value: 1 }])).toEqual({
        outcome: 'unchanged',
        text,
        hasBom,
      })
    },
  )

  test.each([
    [1, 'unchanged', '{\n  "x": 1e0\n}'],
    [2, 'updated', '{\n  "x": 2\n}'],
  ] as const)(
    'BOM handoff returns BOM-less text and hasBom for x=%i (%s)',
    (next, outcome, text) => {
      const result = update('\uFEFF{\n  "x": 1e0\n}', [
        { setting: 'x', value: next },
      ])
      expect(result).toEqual({ outcome, text, hasBom: true })
      expect(result.text.startsWith('\uFEFF')).toBe(false)
      expect(`${result.hasBom ? '\uFEFF' : ''}${result.text}`).toBe(
        `\uFEFF${text}`,
      )
    },
  )

  test('equality uses the chosen destination and the working value', () => {
    const source = '{"wait":{"default":1,"pi":2e0}}'
    const result = update(source, [
      { setting: 'wait', value: 3 },
      { setting: 'wait', value: 2 },
    ])
    expect(result).toEqual({
      outcome: 'unchanged',
      text: source,
      hasBom: false,
    })
    expect(update(source, [{ setting: 'wait', value: 1 }]).outcome).toBe(
      'updated',
    )
  })

  test('the second equal edit is dropped without reformatting', () => {
    const source = '{"x":1}'
    const first = update(source, [{ setting: 'x', value: 2 }])
    expect(
      update(source, [
        { setting: 'x', value: 2 },
        { setting: 'x', value: 2 },
      ]),
    ).toEqual(first)
  })

  test('requires complete record objects after the whole batch, not each edit', () => {
    const source = '{"limits":{"a":{"max":1,"min":0}}}'
    refuses(source, [{ setting: 'limits', path: ['b', 'max'], value: 2 }])
    refuses(source, [{ setting: 'limits', path: ['a', 'min'], remove: true }])
    const result = update(source, [
      { setting: 'limits', path: ['b', 'max'], value: 2 },
      { setting: 'limits', path: ['b', 'min'], value: 1 },
    ])
    expect(value(result.text)).toEqual({
      limits: { a: { max: 1, min: 0 }, b: { max: 2, min: 1 } },
    })
  })

  test('nested records and lists are the first whole resolution units', () => {
    const source =
      '{"sidebar":{"collapsed":"yes","limits":{"a":{"max":1,"min":0}}}}'
    refuses(source, [
      { setting: 'sidebar', path: ['limits', 'a', 'min'], remove: true },
    ])
    refuses(source, [
      { setting: 'sidebar', path: ['rows'], value: [{ max: 1 }] },
    ])
    const result = update(source, [
      { setting: 'sidebar', path: ['limits', 'b', 'max'], value: 2 },
      { setting: 'sidebar', path: ['limits', 'b', 'min'], value: 0 },
    ])
    expect(value(result.text)).toEqual({
      sidebar: {
        collapsed: 'yes',
        limits: { a: { max: 1, min: 0 }, b: { max: 2, min: 0 } },
      },
    })
  })

  test('an invalid sibling object field is outside the edited resolution unit', () => {
    const source = '{"sidebar":{"collapsed":"yes","width":1}}'
    const result = update(source, [
      { setting: 'sidebar', path: ['width'], value: 2 },
    ])
    expect(value(result.text)).toEqual({
      sidebar: { collapsed: 'yes', width: 2 },
    })
  })

  test('file validation allows unknown fields inside a complete record object', () => {
    const source = '{"limits":{"a":{"max":1,"min":0,"extra":"keep"}}}'
    const result = update(source, [
      { setting: 'limits', path: ['a', 'max'], value: 2 },
    ])
    expect(value(result.text)).toEqual({
      limits: { a: { max: 2, min: 0, extra: 'keep' } },
    })
  })

  test('a removed resolution unit may be absent at the end', () => {
    const result = update('{"limits":{"a":{"max":1,"min":0}}}', [
      { setting: 'limits', path: ['a', 'min'], remove: true },
      { setting: 'limits', remove: true },
    ])
    expect(value(result.text)).toEqual({})
  })

  test('prototype-like declared settings and record keys are ordinary own keys', () => {
    const result = update('{}', [
      { setting: 'constructor', value: 2 },
      { setting: 'labels', path: ['__proto__'], value: 'safe' },
    ])
    expect(value(result.text)).toEqual({
      constructor: 2,
      labels: JSON.parse('{"__proto__":"safe"}'),
    })
    expect(Object.getPrototypeOf(value(result.text))).toBe(Object.prototype)
  })
})
