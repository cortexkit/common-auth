import { describe, expect, test } from 'bun:test'
import { defineSettings } from '../../src/settings/define.js'
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
} from '../../src/settings/descriptors.js'
import { settingsJsonSchema } from '../../src/settings/schema.js'

function schemaFor(value: ValueDescriptor, defaultValue: unknown): unknown {
  return settingsJsonSchema(
    defineSettings({
      plugin: 'example',
      settings: { sample: { value, default: defaultValue, hosts: 'both' } },
    }),
  ).properties.sample
}

describe('settingsJsonSchema', () => {
  test('emits the closed draft 2020-12 root with every setting and envelope property', () => {
    const definition = defineSettings({
      plugin: 'example',
      settings: {
        enabled: { value: boolean(), default: true, hosts: 'pi' },
        constructor: { value: string(), default: '', hosts: 'opencode' },
      },
    })

    expect<unknown>(settingsJsonSchema(definition)).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        schema_version: { type: 'integer', minimum: 1 },
        $schema: { type: 'string' },
        enabled: { type: 'boolean' },
        constructor: { type: 'string' },
      },
      additionalProperties: false,
    })
  })

  test.each([
    ['boolean', boolean(), true, { type: 'boolean' }],
    ['string', string(), '', { type: 'string' }],
    ['integer', integer(), 1, { type: 'integer' }],
    ['number', number(), 1.5, { type: 'number' }],
    ['oneOf', oneOf(['a', 'b']), 'a', { enum: ['a', 'b'] }],
    [
      'bounded integer',
      integer({ min: 0, max: 4 }),
      2,
      { type: 'integer', minimum: 0, maximum: 4 },
    ],
    [
      'bounded number',
      number({ min: -1.5, max: 0 }),
      -0.5,
      { type: 'number', minimum: -1.5, maximum: 0 },
    ],
    ['minimum only', number({ min: 0 }), 0, { type: 'number', minimum: 0 }],
    ['maximum only', integer({ max: 0 }), 0, { type: 'integer', maximum: 0 }],
    [
      'list',
      list(integer({ min: 0 })),
      [1],
      { type: 'array', items: { type: 'integer', minimum: 0 } },
    ],
    [
      'record',
      record(string()),
      { key: 'value' },
      { type: 'object', additionalProperties: { type: 'string' } },
    ],
  ] as const)(
    'maps the %s descriptor',
    (_name, descriptor, value, expected) => {
      expect(schemaFor(descriptor, value)).toEqual(expected)
    },
  )

  test('object settings and nested object fields are closed but remain partial', () => {
    expect(
      schemaFor(
        object({
          width: integer(),
          nested: object({ collapsed: boolean() }),
          ['__proto__']: string(),
        }),
        { width: 3, nested: { collapsed: false }, ['__proto__']: 'ordinary' },
      ),
    ).toEqual({
      type: 'object',
      properties: {
        width: { type: 'integer' },
        nested: {
          type: 'object',
          properties: { collapsed: { type: 'boolean' } },
          additionalProperties: false,
        },
        ['__proto__']: { type: 'string' },
      },
      additionalProperties: false,
    })
  })

  test('list objects and their nested object fields require all declared fields', () => {
    expect(
      schemaFor(
        list(
          object({ name: string(), nested: object({ enabled: boolean() }) }),
        ),
        [{ name: 'a', nested: { enabled: true } }],
      ),
    ).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          nested: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } },
            additionalProperties: false,
            required: ['enabled'],
          },
        },
        additionalProperties: false,
        required: ['name', 'nested'],
      },
    })
  })

  test('record values require complete objects without requiring record keys', () => {
    expect(
      schemaFor(
        record(object({ max: integer(), nested: object({ min: number() }) })),
        { account: { max: 2, nested: { min: 0.5 } } },
      ),
    ).toEqual({
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          max: { type: 'integer' },
          nested: {
            type: 'object',
            properties: { min: { type: 'number' } },
            additionalProperties: false,
            required: ['min'],
          },
        },
        additionalProperties: false,
        required: ['max', 'nested'],
      },
    })
  })

  test('collections nested in a partial object still require complete object elements', () => {
    expect(
      schemaFor(
        object({ groups: list(record(object({ enabled: boolean() }))) }),
        { groups: [{ team: { enabled: true } }] },
      ),
    ).toEqual({
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: { enabled: { type: 'boolean' } },
              additionalProperties: false,
              required: ['enabled'],
            },
          },
        },
      },
      additionalProperties: false,
    })
  })

  test.each([
    [
      'default only',
      {},
      {
        type: 'object',
        properties: { default: { enum: ['a', 'b'] } },
        additionalProperties: false,
      },
    ],
    [
      'host only',
      { host: true },
      {
        type: 'object',
        properties: {
          default: { enum: ['a', 'b'] },
          opencode: { enum: ['a', 'b'] },
          pi: { enum: ['a', 'b'] },
        },
        additionalProperties: false,
      },
    ],
    [
      'model only',
      { model: true },
      {
        type: 'object',
        properties: { default: { enum: ['a', 'b'] } },
        additionalProperties: { enum: ['a', 'b'] },
        propertyNames: { not: { enum: ['opencode', 'pi'] } },
      },
    ],
    [
      'host and model',
      { host: true, model: true },
      {
        type: 'object',
        properties: {
          default: { enum: ['a', 'b'] },
          opencode: { enum: ['a', 'b'] },
          pi: { enum: ['a', 'b'] },
        },
        additionalProperties: { enum: ['a', 'b'] },
      },
    ],
  ] as const)(
    'permits a plain value or exactly the %s override keys',
    (_name, overrides, expected) => {
      const definition = defineSettings({
        plugin: 'example',
        settings: {
          choice: {
            value: oneOf(['a', 'b']),
            default: 'a',
            hosts: 'both',
            overrides,
          },
        },
      })

      expect<unknown>(settingsJsonSchema(definition).properties.choice).toEqual(
        {
          anyOf: [{ enum: ['a', 'b'] }, expected],
        },
      )
    },
  )

  test('override values retain list item completeness and numeric bounds', () => {
    const definition = defineSettings({
      plugin: 'example',
      settings: {
        limits: {
          value: list(object({ max: integer({ min: 0 }) })),
          default: [{ max: 1 }],
          hosts: 'both',
          overrides: { model: true },
        },
      },
    })
    const expectedValue = {
      type: 'array',
      items: {
        type: 'object',
        properties: { max: { type: 'integer', minimum: 0 } },
        additionalProperties: false,
        required: ['max'],
      },
    }

    expect<unknown>(settingsJsonSchema(definition).properties.limits).toEqual({
      anyOf: [
        expectedValue,
        {
          type: 'object',
          properties: { default: expectedValue },
          additionalProperties: expectedValue,
          propertyNames: { not: { enum: ['opencode', 'pi'] } },
        },
      ],
    })
  })

  test('two calls return deep-equal schemas without changing the definition', () => {
    const definition = defineSettings({
      plugin: 'example',
      settings: {
        choice: {
          value: oneOf(['b', 'a']),
          default: 'b',
          hosts: 'both',
          overrides: { host: true, model: true },
        },
        groups: {
          value: record(list(object({ count: integer({ max: 4 }) }))),
          default: { team: [{ count: 2 }] },
          hosts: 'both',
        },
      },
    })
    const original = structuredClone(definition)
    const first = settingsJsonSchema(definition)

    expect(settingsJsonSchema(definition)).toEqual(first)
    expect(definition).toEqual(original)
  })
})
