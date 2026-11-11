import { afterEach, describe, expect, test } from 'bun:test'
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { SettingsFs, setSettingsFsForTest } from '../../src/settings/fs.js'
import { parseSettings } from '../../src/settings/parse.js'

const native = {
  readFile,
  stat,
  lstat,
  realpath,
  open,
  rename,
  link,
  unlink,
  mkdir,
  readdir,
}

describe('settings parser', () => {
  test('accepts comments and trailing commas', () => {
    const parsed = parseSettings('// settings\n{ "x": 2, /* keep */ }')
    expect(parsed.parseable).toBe(true)
    if (!parsed.parseable) throw new Error('expected parsed settings')
    expect(parsed.value).toEqual({ x: 2 })
    expect(parsed.tree?.type).toBe('object')
    expect(parsed.hasDuplicates).toBe(false)
  })

  test.each(['', ' \t\r\n'])(
    'reads empty or whitespace text as an object: %j',
    (text) => {
      const parsed = parseSettings(text)
      expect(parsed.parseable).toBe(true)
      if (!parsed.parseable) throw new Error('expected parsed settings')
      expect(parsed.value).toEqual({})
    },
  )

  test.each(['[]', '5', 'null', '{"x": 2', '{"x": ,}', '{"x": 2} garbage'])(
    'rejects a non-object root or parse error: %s',
    (text) => {
      expect(parseSettings(text).parseable).toBe(false)
    },
  )

  test('strips exactly one leading BOM and records the stripped text', () => {
    const text = '// saved by an editor\n{"x": 3}'
    const parsed = parseSettings(`\uFEFF${text}`)
    expect(parsed.parseable).toBe(true)
    if (!parsed.parseable) throw new Error('expected parsed settings')
    expect(parsed.value).toEqual({ x: 3 })
    expect(parsed.hasBom).toBe(true)
    expect(parsed.text).toBe(text)
    expect(parsed.tree?.offset).toBe(text.indexOf('{'))
    expect(parseSettings(text).hasBom).toBe(false)
    expect(parseSettings('\uFEFF').parseable).toBe(true)
    expect(parseSettings('\uFEFF\uFEFF').parseable).toBe(false)
  })

  test('passes a misplaced BOM to the parser unchanged', () => {
    expect(parseSettings(' \uFEFF{"x": 1}').parseable).toBe(false)
    expect(parseSettings('{"x": 1}\uFEFF').parseable).toBe(false)
    const parsed = parseSettings('{"x": "\uFEFF"}')
    expect(parsed.parseable).toBe(true)
    if (!parsed.parseable) throw new Error('expected parsed settings')
    expect(parsed.hasBom).toBe(false)
    expect(parsed.value.x).toBe('\uFEFF')
  })

  test('builds __proto__ as an own data property without changing prototypes', () => {
    const parsed = parseSettings(
      '{"__proto__": {"x": 1}, "items": [{"__proto__": 2}]}',
    )
    expect(parsed.parseable).toBe(true)
    if (!parsed.parseable) throw new Error('expected parsed settings')
    expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype)
    expect(Object.hasOwn(parsed.value, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(parsed.value, '__proto__')).toEqual({
      value: { x: 1 },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    expect(Object.hasOwn(parsed.value, 'x')).toBe(false)
    const item = (parsed.value.items as Record<string, unknown>[])[0]
    expect(Object.getPrototypeOf(item)).toBe(Object.prototype)
    expect(Object.hasOwn(item as object, '__proto__')).toBe(true)
  })

  test.each([
    ['{"x": 1, "x": 2, "x": 3}', { x: 3 }, [['x']]],
    [
      '{"x": {"default": 1, "pi": 2, "pi": 3}}',
      { x: { default: 1, pi: 3 } },
      [['x', 'pi']],
    ],
    ['{"x": [{"y": 1, "y": 2}]}', { x: [{ y: 2 }] }, [['x', '0', 'y']]],
  ])(
    'keeps last values and one duplicate path for %s',
    (text, value, paths) => {
      const parsed = parseSettings(text as string)
      expect(parsed.parseable).toBe(true)
      if (!parsed.parseable) throw new Error('expected parsed settings')
      expect(parsed.value).toEqual(value)
      expect(parsed.duplicateKeyPaths).toEqual(paths)
      expect(parsed.hasDuplicates).toBe(true)
    },
  )
})

describe('settings filesystem seam', () => {
  afterEach(() => setSettingsFsForTest())

  test('defaults every operation, including folder open, to fs promises', () => {
    for (const key of [
      'readFile',
      'stat',
      'lstat',
      'realpath',
      'open',
      'rename',
      'link',
      'unlink',
      'mkdir',
      'readdir',
    ] as const) {
      expect(SettingsFs[key]).toBe(native[key])
    }
  })

  test('swaps operations on the shared object and resets omitted methods', () => {
    const shared = SettingsFs
    const stat: typeof native.stat = (() => {
      throw new Error('injected stat')
    }) as typeof native.stat
    setSettingsFsForTest({ stat })
    expect(shared.stat).toBe(stat)
    expect(shared.readFile).toBe(native.readFile)
    setSettingsFsForTest({})
    expect(shared.stat).toBe(native.stat)
  })
})
