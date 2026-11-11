import { describe, expect, expectTypeOf, test } from 'bun:test'
import {
  defineSettings,
  type SettingDeclaration,
  validateSettingValue,
} from '../../src/settings/define.js'
import {
  boolean,
  integer,
  list,
  number,
  object,
  oneOf,
  record,
  string,
  type ValueDescriptor,
  type ValueOf,
  validateValue,
} from '../../src/settings/descriptors.js'

describe('value descriptors', () => {
  test.each([
    [boolean(), true, 'true'],
    [integer(), 2, 1.5],
    [number(), 1.5, Number.NaN],
    [string(), 'text', 1],
    [oneOf(['a', 'b']), 'a', 'c'],
    [list(integer()), [1, 2], [1, 1.5]],
    [object({ width: integer() }), { width: 2 }, { width: 'wide' }],
    [record(integer()), { account: 2 }, { account: 'two' }],
  ] as const)(
    '%j accepts its sample and rejects an invalid value',
    (descriptor, valid, invalid) => {
      expect(validateValue(descriptor, valid)).toBe(true)
      expect(validateValue(descriptor, invalid)).toBe(false)
      expect(Object.isFrozen(descriptor)).toBe(true)
    },
  )

  test.each([integer, number])(
    '%p enforces inclusive bounds and finite numbers',
    (build) => {
      const bounded = build({ min: 1, max: 3 })
      expect(validateValue(bounded, 1)).toBe(true)
      expect(validateValue(bounded, 3)).toBe(true)
      expect(validateValue(bounded, 0)).toBe(false)
      expect(validateValue(bounded, 4)).toBe(false)
      expect(validateValue(bounded, Number.POSITIVE_INFINITY)).toBe(false)
      expect(validateValue(bounded, Number.NEGATIVE_INFINITY)).toBe(false)
      expect(validateValue(build({ min: 1 }), 0)).toBe(false)
      expect(validateValue(build({ max: 3 }), 4)).toBe(false)
      expect(validateValue(build(), Number.NaN)).toBe(false)
    },
  )

  test('descriptor payloads are copied and deeply frozen', () => {
    const choices = ['a', 'b']
    const choice = oneOf(choices)
    choices.push('c')
    expect(choice.values).toEqual(['a', 'b'])
    expect(Object.isFrozen(choice.values)).toBe(true)

    const fields = { choice }
    const descriptor = record(list(object(fields)))
    fields.choice = oneOf(['c'])
    expect(descriptor.value.item.fields.choice).toBe(choice)
    expect(Object.isFrozen(descriptor.value)).toBe(true)
    expect(Object.isFrozen(descriptor.value.item)).toBe(true)
    expect(Object.isFrozen(descriptor.value.item.fields)).toBe(true)
  })

  test('ValueOf preserves literal unions and maps all descriptor shapes', () => {
    const choice = oneOf(['a', 'b'])
    expectTypeOf<ValueOf<typeof choice>>().toEqualTypeOf<'a' | 'b'>()
    const profile = object({
      enabled: boolean(),
      count: integer(),
      weight: number(),
      name: string(),
      choices: list(choice),
      accounts: record(object({ mode: choice })),
    })
    expectTypeOf<ValueOf<typeof profile>>().toEqualTypeOf<{
      enabled: boolean
      count: number
      weight: number
      name: string
      choices: ('a' | 'b')[]
      accounts: Record<string, { mode: 'a' | 'b' }>
    }>()
    // @ts-expect-error Choices must be strings, not arbitrary JSON values.
    oneOf([1])
  })

  const sidebar = object({
    width: integer(),
    appearance: object({ collapsed: boolean(), title: string() }),
  })

  test.each(['file', 'update', 'map'])(
    '%s permits missing object fields at every mergeable level',
    (source) => {
      const options = { allowUnknownFields: source === 'file' }
      expect(validateValue(sidebar, {}, options)).toBe(true)
      expect(
        validateValue(sidebar, { appearance: { collapsed: true } }, options),
      ).toBe(true)
      expect(validateValue(sidebar, { width: 'wide' }, options)).toBe(false)
      expect(
        validateValue(sidebar, { appearance: { collapsed: 'yes' } }, options),
      ).toBe(false)
    },
  )

  test.each(['file', 'update', 'map'])(
    '%s requires complete objects inside lists and records',
    (source) => {
      const options = { allowUnknownFields: source === 'file' }
      const partial = { width: 3, appearance: { collapsed: true } }
      const complete = {
        width: 3,
        appearance: { collapsed: true, title: 'title' },
      }
      for (const descriptor of [list(sidebar), record(sidebar)]) {
        const wrap = (value: unknown) =>
          descriptor.kind === 'list' ? [value] : { account: value }
        expect(validateValue(descriptor, wrap(partial), options)).toBe(false)
        expect(validateValue(descriptor, wrap(complete), options)).toBe(true)
      }
      expect(
        validateValue(list(record(sidebar)), [{ account: partial }], options),
      ).toBe(false)
      expect(
        validateValue(record(list(sidebar)), { account: [partial] }, options),
      ).toBe(false)
    },
  )

  test('file object fields may be unknown but update and map fields must be declared', () => {
    const value = { appearance: { note: 'keep in file' } }
    expect(validateValue(sidebar, value, { allowUnknownFields: true })).toBe(
      true,
    )
    expect(validateValue(sidebar, value)).toBe(false)
    expect(
      validateValue(
        list(object({ width: integer() })),
        [{ width: 1, note: 'x' }],
        {
          allowUnknownFields: true,
        },
      ),
    ).toBe(true)
    expect(
      validateValue(record(object({ width: integer() })), {
        a: { width: 1, note: 'x' },
      }),
    ).toBe(false)
  })

  test('record keys are unrestricted, but every value is checked', () => {
    const descriptor = record(integer())
    expect(
      validateValue(
        descriptor,
        JSON.parse('{"__proto__":1,"constructor":2,"unknown":3}'),
      ),
    ).toBe(true)
    expect(validateValue(descriptor, { first: 1, last: 1.5 })).toBe(false)
    expect(validateValue(descriptor, {})).toBe(true)
  })

  test('objects and records accept only JSON objects and require own fields', () => {
    for (const descriptor of [object({}), record(integer())]) {
      for (const invalid of [null, [], new Date(), 'object', 2]) {
        expect(validateValue(descriptor, invalid)).toBe(false)
      }
      expect(validateValue(descriptor, Object.create(null))).toBe(true)
    }
    const descriptor = object({ constructor: string() })
    expect(validateValue(descriptor, {}, { completeObjects: true })).toBe(false)
    expect(
      validateValue(
        descriptor,
        { constructor: 'own' },
        { completeObjects: true },
      ),
    ).toBe(true)
    expect(validateValue(object({}), { constructor: 'unknown' })).toBe(false)
  })
})

describe('override object validation', () => {
  test.each([
    [undefined, false, false, false, false],
    [{}, true, false, false, false],
    [{ host: true }, true, true, true, false],
    [{ model: true }, true, false, false, true],
    [{ host: true, model: true }, true, true, true, true],
  ] as const)(
    'enforces permitted override keys for %j',
    (overrides, top, opencode, pi, model) => {
      const declaration = { value: integer(), overrides }
      expect(validateSettingValue(declaration, 15)).toBe(true)
      expect(validateSettingValue(declaration, { default: 15 })).toBe(top)
      expect(validateSettingValue(declaration, { opencode: 2 })).toBe(opencode)
      expect(validateSettingValue(declaration, { pi: 0 })).toBe(pi)
      expect(validateSettingValue(declaration, { 'provider/model': 3 })).toBe(
        model,
      )
      expect(validateSettingValue(declaration, { default: 15, pi: 0 })).toBe(
        top && pi,
      )
      expect(validateSettingValue(declaration, { default: 1.5 })).toBe(false)
      expect(
        validateSettingValue(declaration, { default: 15, pi: 'bad' }),
      ).toBe(false)
      expect(validateSettingValue(declaration, [])).toBe(false)
    },
  )

  test('plain values without overrides still follow their descriptors', () => {
    expect(
      validateSettingValue(
        { value: object({ width: integer() }) },
        { width: 3 },
      ),
    ).toBe(true)
    expect(validateSettingValue({ value: list(integer()) }, [1, 2])).toBe(true)
    expect(validateSettingValue({ value: integer() }, { default: 3 })).toBe(
      false,
    )
  })
})

describe('defineSettings', () => {
  const declaration = { value: integer(), default: 1, hosts: 'both' }

  test('preserves declaration types, metadata and defaults in a deep-frozen definition', () => {
    const modes = oneOf(['a', 'b'])
    const legacy = [{ source: 'opencode', path: ['routing', 'mode'] }]
    const defaultList = ['a']
    const definition = defineSettings({
      plugin: 'example-plugin',
      settings: {
        routing_mode: {
          value: modes,
          default: 'a',
          hosts: 'documentation-only-host',
          overrides: { host: true, model: true },
          project: 'allowed',
          legacy,
        },
        sidebar: {
          value: object({ collapsed: boolean() }),
          default: { collapsed: false },
          hosts: 'both',
        },
        names: { value: list(string()), default: defaultList, hosts: 'pi' },
      },
    })
    expect(definition.plugin).toBe('example-plugin')
    expect(definition.settings.routing_mode).toEqual({
      value: modes,
      default: 'a',
      hosts: 'documentation-only-host',
      overrides: { host: true, model: true },
      project: 'allowed',
      legacy,
    })
    expect(definition.settings.sidebar.project).toBe('user-only')
    expectTypeOf<
      ValueOf<typeof definition.settings.routing_mode.value>
    >().toEqualTypeOf<'a' | 'b'>()
    expectTypeOf(
      definition.settings.routing_mode.project,
    ).toEqualTypeOf<'allowed'>()
    expectTypeOf(
      definition.settings.sidebar.project,
    ).toEqualTypeOf<'user-only'>()
    function assertFrozen(value: unknown) {
      if (value && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true)
        for (const child of Object.values(value)) assertFrozen(child)
      }
    }
    assertFrozen(definition)
    defaultList.push('b')
    legacy[0]!.path.push('more')
    expect(definition.settings.names.default).toEqual(['a'])
    expect(definition.settings.routing_mode.legacy[0]!.path).toEqual([
      'routing',
      'mode',
    ])
  })

  test.each(['routing_mode', 'x', 'x2', 'x_2', 'constructor'])(
    'accepts snake_case name %s',
    (name) => {
      const definition = defineSettings({
        plugin: 'example',
        settings: { [name]: declaration },
      })
      expect(Object.hasOwn(definition.settings, name)).toBe(true)
    },
  )

  test.each([
    'Routing_mode',
    'routing-mode',
    '2routing',
    '_routing',
    'routing.mode',
    '',
    'a\nb',
    'a\n',
  ])('rejects non-snake_case name %j', (name) => {
    expect(() =>
      defineSettings({ plugin: 'example', settings: { [name]: declaration } }),
    ).toThrow(/snake_case/)
  })

  test.each(['schema_version', '$schema'])(
    'rejects reserved name %s',
    (name) => {
      expect(() =>
        defineSettings({
          plugin: 'example',
          settings: { [name]: declaration },
        }),
      ).toThrow(/Reserved/)
    },
  )

  test.each([
    [integer(), 1.5],
    [number(), Number.NaN],
    [oneOf(['a', 'b']), 'c'],
    [object({ width: integer() }), {}],
    [object({ nested: object({ width: integer() }) }), { nested: {} }],
    [object({ width: integer() }), { width: 1, note: 'unknown' }],
    [list(object({ width: integer() })), [{}]],
    [record(object({ width: integer() })), { account: {} }],
  ] as const)(
    'rejects invalid or incomplete default for %j',
    (value, defaultValue) => {
      expect(() =>
        defineSettings({
          plugin: 'example',
          settings: {
            invalid: { value, default: defaultValue, hosts: 'both' },
          },
        }),
      ).toThrow(/Invalid default/)
    },
  )

  test('requires a default at runtime and in declarations', () => {
    const missingDefault = { value: string(), hosts: 'both' }
    // @ts-expect-error Every setting declaration requires a default.
    const invalid: SettingDeclaration = missingDefault
    expect(() =>
      defineSettings({ plugin: 'example', settings: { missing: invalid } }),
    ).toThrow(/Invalid default/)
  })

  test('keeps optional project policies when a declaration has a widened type', () => {
    const declared: SettingDeclaration = {
      ...declaration,
      project: 'allowed',
    }
    const definition = defineSettings({
      plugin: 'example',
      settings: { count: declared },
    })
    expect(definition.settings.count.project).toBe('allowed')
    expectTypeOf(definition.settings.count.project).toEqualTypeOf<
      'user-only' | 'allowed'
    >()
  })

  test('sidebar requires an object descriptor', () => {
    expect(() =>
      defineSettings({ plugin: 'example', settings: { sidebar: declaration } }),
    ).toThrow(/sidebar.*object/)
    expect(
      defineSettings({
        plugin: 'example',
        settings: {
          sidebar: {
            value: object({ width: integer() }),
            default: { width: 1 },
            hosts: 'both',
          },
        },
      }).settings.sidebar.default,
    ).toEqual({ width: 1 })
  })

  test.each([object({}), record(integer())])(
    'rejects overrides on %j',
    (value: ValueDescriptor) => {
      for (const overrides of [
        { host: true },
        { model: true },
        { host: true, model: true },
        {},
      ] as const) {
        expect(() =>
          defineSettings({
            plugin: 'example',
            settings: {
              invalid: { value, default: {}, hosts: 'both', overrides },
            },
          }),
        ).toThrow(/cannot use overrides/)
      }
    },
  )
})
