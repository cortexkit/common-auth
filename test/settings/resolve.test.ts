import { describe, expect, expectTypeOf, test } from 'bun:test'
import { defineSettings } from '../../src/settings/define.js'
import {
  boolean,
  integer,
  list,
  object,
  oneOf,
  record,
  string,
} from '../../src/settings/descriptors.js'
import { parseSettings } from '../../src/settings/parse.js'
import {
  type GetOptions,
  type ResolutionSnapshots,
  resolveSetting,
} from '../../src/settings/resolve.js'
import {
  buildSettingsSnapshot,
  type ReportEntry,
} from '../../src/settings/snapshot.js'

const definition = defineSettings({
  plugin: 'example',
  settings: {
    wait: {
      value: integer({ min: 0 }),
      default: 15,
      hosts: 'both',
      project: 'allowed',
      overrides: { host: true, model: true },
    },
    host_wait: {
      value: integer({ min: 0 }),
      default: 15,
      hosts: 'pi',
      overrides: { host: true },
    },
    model_wait: {
      value: integer(),
      default: 15,
      hosts: 'both',
      overrides: { model: true },
    },
    plain: { value: integer(), default: 10, hosts: 'both', project: 'allowed' },
    private_value: { value: integer(), default: 20, hosts: 'both' },
    constructor: { value: integer(), default: 7, hosts: 'both' },
    routing_mode: { value: oneOf(['a', 'b']), default: 'a', hosts: 'both' },
    sidebar: {
      value: object({
        collapsed: boolean(),
        nested: object({
          width: integer(),
          label: string(),
          appearance: object({ border: boolean(), color: string() }),
        }),
        constructor: string(),
      }),
      default: {
        collapsed: false,
        nested: {
          width: 10,
          label: 'default',
          appearance: { border: false, color: 'blue' },
        },
        constructor: 'default',
      },
      hosts: 'both',
      project: 'allowed',
    },
    rows: {
      value: list(
        object({ name: string(), nested: object({ size: integer() }) }),
      ),
      default: [{ name: 'default', nested: { size: 10 } }],
      hosts: 'both',
      project: 'allowed',
    },
    limits: {
      value: record(object({ max: integer(), min: integer() })),
      default: { fallback: { max: 10, min: 0 } },
      hosts: 'both',
      project: 'allowed',
    },
  },
})

const userFile: ReportEntry['file'] = { kind: 'user', path: '/test/user.jsonc' }
const projectFile: ReportEntry['file'] = {
  kind: 'project',
  path: '/test/project/.cortexkit/example.jsonc',
}
const snapshot = (text: string, file = userFile) =>
  buildSettingsSnapshot(definition, file, parseSettings(text))
const entry = (
  keyPath: string[],
  reason: ReportEntry['reason'],
  file = userFile,
): ReportEntry => ({ file, keyPath, reason })
const resolve = <K extends keyof typeof definition.settings>(
  name: K,
  snapshots: ResolutionSnapshots = {},
  options: GetOptions = { host: 'opencode' },
) => resolveSetting(definition, name, options, snapshots)

const projectOptions = {
  host: 'pi',
  model: 'vendor/model',
  project: '/test/project',
}

describe('settings resolution', () => {
  test('project plain values beat user model overrides before the declared default', () => {
    const user = snapshot(
      '{"wait": {"vendor/model": 2, "pi": 3, "default": 4}}',
    )
    const project = snapshot('{"wait": 1}', projectFile)
    expect(resolve('wait', { user, project }, projectOptions)).toBe(1)
    expect(resolve('wait', { user }, projectOptions)).toBe(2)
    expect(resolve('wait', {}, projectOptions)).toBe(15)
    expect(user.entries).toEqual([])
    expect(project.entries).toEqual([])
  })

  test('a supplied project snapshot is ignored unless a project is requested', () => {
    const project = snapshot('{"plain": 1}', projectFile)
    const user = snapshot('{"plain": 2}')
    expect(resolve('plain', { user, project })).toBe(2)
    expect(resolve('plain', { project })).toBe(10)
  })

  test('user-only project settings are skipped and reported while user values still apply', () => {
    const project = snapshot('{"private_value": 1}', projectFile)
    const user = snapshot('{"private_value": 2}')
    expect(resolve('private_value', { user, project }, projectOptions)).toBe(2)
    expect(resolve('private_value', { project }, projectOptions)).toBe(20)
    expect(project.entries).toEqual([
      entry(['private_value'], 'user-only-in-project', projectFile),
    ])
    // Enforce the project policy even if the supplied snapshot contains a user value.
    expect(resolve('private_value', { project: user }, projectOptions)).toBe(20)
  })

  test.each([
    [{ host: 'pi', model: 'vendor/model' }, 1],
    [{ host: 'opencode', model: 'vendor/model' }, 1],
    [{ host: 'pi', model: 'Vendor/model' }, 2],
    [{ host: 'pi', model: 'vendor/model-extra' }, 2],
    [{ host: 'opencode', model: 'missing' }, 3],
    [{ host: 'other', model: 'vendor/model' }, 1],
    [{ host: 'other' }, 4],
    [{ host: 'vendor/model' }, 4],
    [{ host: 'Pi' }, 4],
    [{ host: 'pi', model: 'default' }, 2],
    [{ host: 'opencode', model: 'pi' }, 3],
    [{ host: 'pi', model: 'opencode' }, 2],
  ] as const)(
    'selects exact model, then supported host, then top level for %j',
    (options, expected) => {
      const user = snapshot(
        '{"wait": {"vendor/model": 1, "pi": 2, "opencode": 3, "default": 4}}',
      )
      expect(resolve('wait', { user }, options)).toBe(expected)
      expect(user.entries).toEqual([])
    },
  )

  test('host-only overrides accept default and zero without reporting or gating by hosts metadata', () => {
    const user = snapshot('{"host_wait": {"default": 15, "pi": 0}}')
    expect(resolve('host_wait', { user }, { host: 'pi' })).toBe(0)
    expect(resolve('host_wait', { user }, { host: 'opencode' })).toBe(15)
    expect(user.entries).toEqual([])
  })

  test('model-only overrides ignore host keys and retain their default', () => {
    const user = snapshot('{"model_wait": {"default": 9, "pi": 0, "exact": 1}}')
    expect(resolve('model_wait', { user }, { host: 'pi' })).toBe(9)
    expect(
      resolve('model_wait', { user }, { host: 'pi', model: 'exact' }),
    ).toBe(1)
    expect(user.entries).toEqual([
      entry(['model_wait', 'pi'], 'override-not-allowed'),
    ])
  })

  test('invalid overrides fall back within the file and are reported even for another host', () => {
    const user = snapshot('{"wait": {"default": 8, "pi": "bad", "model": -1}}')
    expect(user.entries).toEqual([
      entry(['wait', 'pi'], 'invalid-value'),
      entry(['wait', 'model'], 'invalid-value'),
    ])
    expect(resolve('wait', { user }, { host: 'opencode' })).toBe(8)
    expect(resolve('wait', { user }, { host: 'pi', model: 'model' })).toBe(8)
    expect(user.entries).toHaveLength(2)
  })

  test('an invalid model falls back to a valid host before the override default', () => {
    const user = snapshot('{"wait": {"model": "bad", "pi": 0, "default": 8}}')
    expect(resolve('wait', { user }, { host: 'pi', model: 'model' })).toBe(0)
    expect(user.entries).toEqual([entry(['wait', 'model'], 'invalid-value')])
  })

  test('missing or unusable project overrides fall through to the user, then default', () => {
    for (const text of [
      '{"wait": {}}',
      '{"wait": {"pi": "bad"}}',
      '{"wait": -1}',
    ]) {
      const project = snapshot(text, projectFile)
      const user = snapshot('{"wait": 6}')
      expect(resolve('wait', { user, project }, projectOptions)).toBe(6)
      expect(resolve('wait', { project }, projectOptions)).toBe(15)
    }
  })

  test('a disallowed override object falls through without losing lower levels', () => {
    const project = snapshot('{"plain": {"default": 15}}', projectFile)
    const user = snapshot('{"plain": 3}')
    expect(resolve('plain', { user, project }, projectOptions)).toBe(3)
    expect(resolve('plain', { user: project })).toBe(10)
    expect(project.entries).toEqual([
      entry(['plain'], 'override-not-allowed', projectFile),
    ])
  })

  test('a host-only setting ignores a disallowed model key and retains valid siblings', () => {
    const user = snapshot('{"host_wait": {"model": 1, "pi": 0, "default": 8}}')
    expect(resolve('host_wait', { user }, { host: 'pi', model: 'model' })).toBe(
      0,
    )
    expect(
      resolve('host_wait', { user }, { host: 'opencode', model: 'model' }),
    ).toBe(8)
    expect(user.entries).toEqual([
      entry(['host_wait', 'model'], 'override-not-allowed'),
    ])
  })

  test('lists and records replace whole values at each level instead of merging', () => {
    const user = snapshot(`{
      "rows": [{"name": "user", "nested": {"size": 2}}],
      "limits": {"user": {"max": 2, "min": 0}, "shared": {"max": 3, "min": 1}}
    }`)
    const project = snapshot(
      `{
      "rows": [{"name": "project", "nested": {"size": 1}}],
      "limits": {"shared": {"max": 1, "min": 0}}
    }`,
      projectFile,
    )
    expect(resolve('rows', { user, project }, projectOptions)).toEqual([
      { name: 'project', nested: { size: 1 } },
    ])
    expect(resolve('limits', { user, project }, projectOptions)).toEqual({
      shared: { max: 1, min: 0 },
    })
    expect(resolve('rows', { user })).toEqual([
      { name: 'user', nested: { size: 2 } },
    ])
    expect(resolve('limits', { user })).toEqual({
      user: { max: 2, min: 0 },
      shared: { max: 3, min: 1 },
    })
    const empty = snapshot('{"rows": [], "limits": {}}', projectFile)
    expect(resolve('rows', { user, project: empty }, projectOptions)).toEqual(
      [],
    )
    expect(resolve('limits', { user, project: empty }, projectOptions)).toEqual(
      {},
    )
  })

  test('one incomplete item skips the entire list or record instead of filling it from lower levels', () => {
    const project = snapshot(
      `{
      "rows": [{"name": "incomplete"}, {"name": "valid", "nested": {"size": 1}}],
      "limits": {"incomplete": {"max": 1}, "valid": {"max": 2, "min": 0}}
    }`,
      projectFile,
    )
    const user = snapshot(`{
      "rows": [{"name": "user", "nested": {"size": 3}}],
      "limits": {"user": {"max": 3, "min": 0}}
    }`)
    expect(resolve('rows', { user, project }, projectOptions)).toEqual([
      { name: 'user', nested: { size: 3 } },
    ])
    expect(resolve('limits', { user, project }, projectOptions)).toEqual({
      user: { max: 3, min: 0 },
    })
    expect(project.entries).toEqual([
      entry(['rows', '0', 'nested'], 'invalid-value', projectFile),
      entry(['limits', 'incomplete', 'min'], 'invalid-value', projectFile),
    ])
  })

  test('object fields recursively fill from project, user and default, including false and empty strings', () => {
    const project = snapshot(
      `{"sidebar": {
      "collapsed": false, "nested": {"width": 1, "appearance": {"border": true}}
    }}`,
      projectFile,
    )
    const user = snapshot(`{"sidebar": {
      "collapsed": true, "nested": {"width": 2, "label": "", "appearance": {"border": false}}
    }}`)
    expect(resolve('sidebar', { user, project }, projectOptions)).toEqual({
      collapsed: false,
      nested: {
        width: 1,
        label: '',
        appearance: { border: true, color: 'blue' },
      },
      constructor: 'default',
    })
    expect(user.entries).toEqual([])
    expect(project.entries).toEqual([])
  })

  test('invalid object fields and whole nested objects fall through without discarding valid siblings', () => {
    const project = snapshot(
      `{"sidebar": {
      "collapsed": "yes", "nested": {"width": "wide", "label": "project", "appearance": 5}
    }}`,
      projectFile,
    )
    const user = snapshot(`{"sidebar": {
      "collapsed": true, "nested": {"width": 2, "appearance": {"border": true}}
    }}`)
    expect(resolve('sidebar', { user, project }, projectOptions)).toEqual({
      collapsed: true,
      nested: {
        width: 2,
        label: 'project',
        appearance: { border: true, color: 'blue' },
      },
      constructor: 'default',
    })
    expect(project.entries).toEqual([
      entry(['sidebar', 'collapsed'], 'invalid-value', projectFile),
      entry(['sidebar', 'nested', 'width'], 'invalid-value', projectFile),
      entry(['sidebar', 'nested', 'appearance'], 'invalid-value', projectFile),
    ])
  })

  test('unknown object fields are reported at every depth and excluded from returned objects', () => {
    const user = snapshot(`{"sidebar": {
      "extra": "x", "nested": {"extra": "x", "appearance": {"extra": "x", "color": "red"}}
    }}`)
    expect(resolve('sidebar', { user })).toEqual({
      collapsed: false,
      nested: {
        width: 10,
        label: 'default',
        appearance: { border: false, color: 'red' },
      },
      constructor: 'default',
    })
    expect(user.entries).toEqual([
      entry(['sidebar', 'extra'], 'unknown-key'),
      entry(['sidebar', 'nested', 'extra'], 'unknown-key'),
      entry(['sidebar', 'nested', 'appearance', 'extra'], 'unknown-key'),
    ])
  })

  test('objects inside lists and records drop unknown fields without invalidating their containers', () => {
    const user = snapshot(`{
      "rows": [{"name": "a", "extra": "x", "nested": {"size": 1, "extra": "x"}}],
      "limits": {"a": {"max": 1, "min": 0, "note": "x"}}
    }`)
    expect(resolve('rows', { user })).toEqual([
      { name: 'a', nested: { size: 1 } },
    ])
    expect(resolve('limits', { user })).toEqual({ a: { max: 1, min: 0 } })
    expect(user.entries).toEqual([
      entry(['rows', '0', 'extra'], 'unknown-key'),
      entry(['rows', '0', 'nested', 'extra'], 'unknown-key'),
      entry(['limits', 'a', 'note'], 'unknown-key'),
    ])
  })

  test('record __proto__ and constructor keys remain ordinary own properties', () => {
    const user = snapshot(
      '{"limits": {"__proto__": {"max": 1, "min": 0}, "constructor": {"max": 2, "min": 1}}}',
    )
    const value = resolve('limits', { user })
    expect(Object.keys(value)).toEqual(['__proto__', 'constructor'])
    expect(Object.hasOwn(value, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({
      max: 1,
      min: 0,
    })
    expect(
      Object.getOwnPropertyDescriptor(value, 'constructor')?.value,
    ).toEqual({ max: 2, min: 1 })
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(user.entries).toEqual([])
  })

  test.each(['{}', '{"__proto__": {"constructor": 100}}'])(
    'an absent constructor setting uses its own declared default: %s',
    (text) => {
      const user = snapshot(text)
      expect(resolve('constructor', { user })).toBe(7)
      expect(user.entries).toEqual(
        text === '{}' ? [] : [entry(['__proto__'], 'unknown-key')],
      )
    },
  )

  test('list, record and object results deeply clone snapshots and frozen defaults', () => {
    const user = snapshot(`{
      "rows": [{"name": "user", "nested": {"size": 1}}],
      "limits": {"a": {"max": 1, "min": 0}},
      "sidebar": {"nested": {"width": 1}}
    }`)
    for (const snapshots of [{ user }, {}]) {
      const rows = resolve('rows', snapshots)
      const limits = resolve('limits', snapshots)
      const sidebar = resolve('sidebar', snapshots)
      const before = structuredClone({ rows, limits, sidebar })
      const firstRow = rows[0]
      const firstLimit = Object.values(limits)[0]
      if (!firstRow || !firstLimit)
        throw new Error('expected nonempty collections')
      firstRow.nested.size = 99
      rows.push({ name: 'mutated', nested: { size: 99 } })
      firstLimit.max = 99
      limits.added = { max: 99, min: 99 }
      sidebar.nested.appearance.color = 'mutated'
      expect(resolve('rows', snapshots)).toEqual(before.rows)
      expect(resolve('limits', snapshots)).toEqual(before.limits)
      expect(resolve('sidebar', snapshots)).toEqual(before.sidebar)
    }
    expect(user.settings.rows).toEqual([{ name: 'user', nested: { size: 1 } }])
    expect(user.settings.limits).toEqual({ a: { max: 1, min: 0 } })
    expect(user.settings.sidebar).toEqual({ nested: { width: 1 } })
    expect(definition.settings.rows.default).toEqual([
      { name: 'default', nested: { size: 10 } },
    ])
    expect(definition.settings.limits.default).toEqual({
      fallback: { max: 10, min: 0 },
    })
    expect(definition.settings.sidebar.default.nested.appearance.color).toBe(
      'blue',
    )
  })

  test('resolution preserves descriptor types and rejects undeclared names without reporting', () => {
    expectTypeOf(resolve('routing_mode')).toEqualTypeOf<'a' | 'b'>()
    expectTypeOf(resolve('rows')).toEqualTypeOf<
      { name: string; nested: { size: number } }[]
    >()
    const user = snapshot('{}')
    expect(() => {
      // @ts-expect-error Undeclared setting names are caller errors.
      resolve('typo', { user })
    }).toThrow(new TypeError('Undeclared setting: typo'))
    expect(user.entries).toEqual([])
  })
})
