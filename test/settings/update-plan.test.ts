import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import {
  boolean,
  defineSettings,
  integer,
  list,
  object,
  openSettings,
  type SettingsCurrent,
  type SettingsEdit,
  type SettingsUpdatePlan,
  string,
} from '../../src/settings/index.js'
import { setSettingsWriteStepHookForTest } from '../../src/settings/write.js'

const definition = defineSettings({
  plugin: 'example',
  settings: {
    enabled: { value: boolean(), default: false, hosts: 'both' },
    floors: {
      value: list(object({ account: string(), floor: integer() })),
      default: [],
      hosts: 'both',
    },
  },
})
const context = { host: 'pi' }
const initial = {
  enabled: true,
  floors: [
    { account: 'a', floor: 1 },
    { account: 'b', floor: 2 },
  ],
}
let root: string
let file: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'settings-plan-'))
  file = join(root, 'example.jsonc')
})

afterEach(async () => {
  setSettingsWriteStepHookForTest()
  await fs.rm(root, { recursive: true, force: true })
})

function handle(createMissing = false) {
  return openSettings(definition, {
    file,
    separateInstall: false,
    createMissing,
    log: { warn() {}, info() {} },
  })
}

async function contents() {
  return parse(await fs.readFile(file, 'utf8'))
}

function floorEdits(
  current: SettingsCurrent,
  account: string,
  floor: number,
): readonly SettingsEdit[] {
  if (current.status !== 'ready') throw new Error('Expected an existing file')
  const floors = current.document.floors as typeof initial.floors
  return [
    {
      setting: 'floors',
      value: floors.map((entry) =>
        entry.account === account ? { ...entry, floor } : entry,
      ),
    },
  ]
}

test('concurrent whole-list updates preserve both account floors', async () => {
  await fs.writeFile(file, JSON.stringify(initial))
  const first = handle()
  const second = handle()
  await Promise.all([first.read(), second.read()])
  const firstPlan = mock((current: SettingsCurrent) =>
    floorEdits(current, 'a', 10),
  )
  const secondPlan = mock((current: SettingsCurrent) =>
    floorEdits(current, 'b', 20),
  )
  const firstStaged = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  let stages = 0
  setSettingsWriteStepHookForTest(async () => {
    if (++stages === 1) {
      firstStaged.resolve()
      await releaseFirst.promise
    }
  })
  const firstUpdate = first.update(firstPlan, context)
  await firstStaged.promise
  const secondUpdate = second.update(secondPlan, context)
  releaseFirst.resolve()
  expect(await Promise.all([firstUpdate, secondUpdate])).toEqual([
    { outcome: 'updated' },
    { outcome: 'updated' },
  ])
  expect((await contents()).floors).toEqual([
    { account: 'a', floor: 10 },
    { account: 'b', floor: 20 },
  ])
  expect(firstPlan).toHaveBeenCalledTimes(1)
  expect(secondPlan).toHaveBeenCalledTimes(1)
  expect(secondPlan.mock.calls[0]?.[0]).toMatchObject({
    status: 'ready',
    document: {
      floors: [
        { account: 'a', floor: 10 },
        { account: 'b', floor: 2 },
      ],
    },
  })
})

test('a deleted file is missing at the locked read and a plan can restore protection', async () => {
  await fs.writeFile(file, JSON.stringify(initial))
  const settings = handle(true)
  await settings.read()
  await fs.unlink(file)
  const plan = mock((current: SettingsCurrent) => {
    expect(current).toEqual({ status: 'missing' })
    return [
      { setting: 'enabled', value: true },
      { setting: 'floors', value: initial.floors },
    ]
  })
  expect(await settings.update(plan, context)).toEqual({ outcome: 'updated' })
  expect(plan).toHaveBeenCalledTimes(1)
  expect(await contents()).toEqual({ schema_version: 1, ...initial })
})

test('a recreated file is ready with fresh values rather than a caller snapshot', async () => {
  await fs.writeFile(file, JSON.stringify(initial))
  const settings = handle(true)
  await settings.read()
  await fs.unlink(file)
  const fresh = { enabled: false, floors: [{ account: 'a', floor: 99 }] }
  await fs.writeFile(file, JSON.stringify(fresh))
  const plan = mock((current: SettingsCurrent) => {
    expect(current).toEqual({ status: 'ready', document: fresh })
    return floorEdits(current, 'a', 100)
  })
  expect(await settings.update(plan, context)).toEqual({ outcome: 'updated' })
  expect(plan).toHaveBeenCalledTimes(1)
  expect(await contents()).toEqual({
    enabled: false,
    floors: [{ account: 'a', floor: 100 }],
  })
})

test.each(['', ' \t\r\n'])(
  'an existing empty file %j is ready with an empty document',
  async (source) => {
    await fs.writeFile(file, source)
    const plan = mock((current: SettingsCurrent) => {
      expect(current).toEqual({ status: 'ready', document: {} })
      return [{ setting: 'enabled', value: true }]
    })
    expect(await handle().update(plan, context)).toEqual({ outcome: 'updated' })
    expect(plan).toHaveBeenCalledTimes(1)
    expect(await contents()).toEqual({ schema_version: 1, enabled: true })
  },
)

test('without createMissing a missing file refuses before running the plan', async () => {
  const plan = mock(() => [])
  await expect(handle().update(plan, context)).rejects.toMatchObject({
    code: 'settings-unavailable',
  })
  expect(plan).not.toHaveBeenCalled()
  expect(await Bun.file(file).exists()).toBe(false)
})

test.each([new Error('stop'), { refused: true }, undefined])(
  'a thrown plan value %j propagates unchanged without writing',
  async (error) => {
    const source = '// keep bytes\n{"enabled":false}'
    await fs.writeFile(file, source)
    const plan = mock(() => {
      throw error
    })
    let caught: unknown = Symbol('not thrown')
    try {
      await handle().update(plan, context)
    } catch (value) {
      caught = value
    }
    expect(caught).toBe(error)
    expect(plan).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(file, 'utf8')).toBe(source)
  },
)

test.each([
  async () => [{ setting: 'enabled', value: true }],
  () => ({
    // biome-ignore lint/suspicious/noThenProperty: Exercise rejection of custom thenables without awaiting them.
    then() {
      throw new Error('must not be awaited')
    },
  }),
])('an async or thenable plan is refused without writing', async (plan) => {
  const source = '// keep bytes\n{"enabled":false}'
  await fs.writeFile(file, source)
  // JavaScript callers can return a thenable despite the synchronous type.
  await expect(
    handle().update(plan as unknown as SettingsUpdatePlan, context),
  ).rejects.toMatchObject({
    name: 'SettingsRefusal',
    code: 'settings-invalid-value',
  })
  expect(await fs.readFile(file, 'utf8')).toBe(source)
})

test('the plan document is a deeply frozen plain copy and only edits change the file', async () => {
  await fs.writeFile(file, JSON.stringify(initial))
  const plan: SettingsUpdatePlan = (current) => {
    if (current.status !== 'ready') throw new Error('Expected an existing file')
    const document = current.document as typeof initial
    expect(Object.getPrototypeOf(document)).toBe(Object.prototype)
    expect(Object.isFrozen(current)).toBe(true)
    expect(Object.isFrozen(document)).toBe(true)
    expect(Object.isFrozen(document.floors)).toBe(true)
    expect(Object.isFrozen(document.floors[0])).toBe(true)
    expect(() => {
      document.enabled = false
    }).toThrow(TypeError)
    expect(() => {
      document.floors[0]!.floor = 999
    }).toThrow(TypeError)
    expect(() => {
      document.floors.push({ account: 'c', floor: 3 })
    }).toThrow(TypeError)
    return [{ setting: 'enabled', value: false }]
  }
  expect(await handle().update(plan, context)).toEqual({ outcome: 'updated' })
  expect(await contents()).toEqual({ ...initial, enabled: false })
})

test.each([
  ['{"enabled":', 'settings-unparseable'],
  ['// only a comment\n', 'settings-unparseable'],
  ['{"enabled":true,"enabled":false}', 'settings-unparseable'],
  ['{"schema_version":2}', 'settings-newer-version'],
])('file checks refuse %s before calling a plan', async (source, code) => {
  await fs.writeFile(file, source)
  const plan = mock(() => [{ setting: 'enabled', value: true }])
  await expect(handle().update(plan, context)).rejects.toMatchObject({ code })
  expect(plan).not.toHaveBeenCalled()
  expect(await fs.readFile(file, 'utf8')).toBe(source)
})

test('plan edits preserve comments and use the same validation as arrays', async () => {
  const source = '{\n  // protection\n  "enabled": false\n}\n'
  await fs.writeFile(file, source)
  const settings = handle()
  await expect(
    settings.update(() => [{ setting: 'enabled', value: 'bad' }], context),
  ).rejects.toMatchObject({ code: 'settings-invalid-value' })
  expect(await fs.readFile(file, 'utf8')).toBe(source)
  expect(
    await settings.update(() => [{ setting: 'enabled', value: true }], context),
  ).toEqual({ outcome: 'updated' })
  expect(await fs.readFile(file, 'utf8')).toBe(source.replace('false', 'true'))
})

test.each([{ edits: [] }, { edits: [{ setting: 'enabled', value: true }] }])(
  'net-equal plan edits %j preserve bytes',
  async ({ edits }) => {
    const source = '{ /* keep */ "enabled": true }\n'
    await fs.writeFile(file, source)
    expect(await handle().update(() => edits, context)).toEqual({
      outcome: 'unchanged',
    })
    expect(await fs.readFile(file, 'utf8')).toBe(source)
  },
)

test('an empty plan on a missing file is unchanged and creates no file', async () => {
  expect(await handle(true).update(() => [], context)).toEqual({
    outcome: 'unchanged',
  })
  expect(await Bun.file(file).exists()).toBe(false)
})
