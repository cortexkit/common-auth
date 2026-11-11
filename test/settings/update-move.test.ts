import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { defineSettings } from '../../src/settings/define.js'
import { integer } from '../../src/settings/descriptors.js'
import { SettingsFs } from '../../src/settings/fs.js'
import { openSettings } from '../../src/settings/handle.js'
import {
  moveSettingsOnce,
  setSettingsMoveStepHookForTest,
} from '../../src/settings/move.js'
import { SettingsRefusal } from '../../src/settings/refusal.js'
import { setSettingsWriteStepHookForTest } from '../../src/settings/write.js'

const definition = defineSettings({
  plugin: 'example',
  settings: { x: { value: integer(), default: 1, hosts: 'both' } },
})
const log = { warn: () => {}, info: () => {} }
const context = { host: 'pi' }
let root: string
let file: string
let source: string
let restoreSpies: (() => void)[]

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'settings-update-move-'))
  file = join(root, 'example.jsonc')
  source = join(root, 'legacy.json')
  await fs.writeFile(source, '{"x":7}\n')
  restoreSpies = []
})

afterEach(async () => {
  for (const restore of restoreSpies) restore()
  setSettingsWriteStepHookForTest()
  setSettingsMoveStepHookForTest()
  await fs.rm(root, { recursive: true, force: true })
})

function handle(createMissing = false) {
  return openSettings(definition, {
    file,
    separateInstall: false,
    createMissing,
    log,
  })
}

function move() {
  return moveSettingsOnce({
    definition,
    target: file,
    separateInstall: false,
    sources: [{ host: 'pi', path: source, locks: [], read: JSON.parse }],
    map: (legacy) => ({
      entries: legacy.flatMap((entry, index) =>
        entry.present
          ? [
              {
                source: index,
                setting: 'x',
                value: (entry.value as { x: number }).x,
              },
            ]
          : [],
      ),
      unmapped: [],
    }),
    fence: () => true,
    log,
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function publications() {
  const link = spyOn(SettingsFs, 'link')
  const rename = spyOn(SettingsFs, 'rename')
  restoreSpies.push(
    () => link.mockRestore(),
    () => rename.mockRestore(),
  )
  return { link, rename }
}

describe('settings update and move publication', () => {
  test('a staged createMissing update refuses settings-busy after a move publishes', async () => {
    const { link, rename } = publications()
    const staged = deferred()
    const release = deferred()
    let updateTemp = ''
    let moveTemp = ''
    setSettingsWriteStepHookForTest(async (_step, paths) => {
      updateTemp = paths.temp
      staged.resolve()
      await release.promise
    })
    setSettingsMoveStepHookForTest((step, paths) => {
      if (step === 'staged') moveTemp = paths.temp ?? ''
    })
    const pendingUpdate = handle(true)
      .update([{ setting: 'x', value: 2 }], context)
      .catch((error: unknown) => error)
    try {
      await staged.promise
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      const moved = await move()
      expect(moved.outcome).toBe('moved')
      const movedBytes = await fs.readFile(file)
      expect(parse(movedBytes.toString())).toEqual({ schema_version: 1, x: 7 })

      release.resolve()
      const refused = await pendingUpdate
      expect(refused).toBeInstanceOf(SettingsRefusal)
      expect(refused).toMatchObject({ code: 'settings-busy' })
      expect(await fs.readFile(file)).toEqual(movedBytes)
      expect(link.mock.calls).toEqual([
        [moveTemp, file],
        [updateTemp, file],
      ])
      expect(rename).not.toHaveBeenCalled()
      await expect(fs.lstat(updateTemp)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(fs.lstat(moveTemp)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      release.resolve()
      await pendingUpdate
    }
  })

  test('a missing file without createMissing refuses and leaves a later move free to publish', async () => {
    const { link, rename } = publications()
    const before = await fs.readdir(root)
    const refused = await handle()
      .update([{ setting: 'x', value: 2 }], context)
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(SettingsRefusal)
    expect(refused).toMatchObject({ code: 'settings-unavailable' })
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(root)).toEqual(before)
    expect(link).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()

    expect((await move()).outcome).toBe('moved')
    expect(parse(await fs.readFile(file, 'utf8'))).toEqual({
      schema_version: 1,
      x: 7,
    })
    expect(link).toHaveBeenCalledTimes(1)
    expect(link).toHaveBeenCalledWith(expect.any(String), file)
    expect(rename).not.toHaveBeenCalled()
  })

  test('a staged move cannot replace a missing file published by createMissing update', async () => {
    const { link, rename } = publications()
    const staged = deferred()
    const release = deferred()
    let updateTemp = ''
    let moveTemp = ''
    setSettingsMoveStepHookForTest(async (step, paths) => {
      if (step !== 'staged') return
      moveTemp = paths.temp ?? ''
      staged.resolve()
      await release.promise
    })
    setSettingsWriteStepHookForTest((_step, paths) => {
      updateTemp = paths.temp
    })
    const pendingMove = move()
    try {
      await staged.promise
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        await handle(true).update([{ setting: 'x', value: 2 }], context),
      ).toEqual({ outcome: 'updated' })
      const updatedBytes = await fs.readFile(file)
      expect(parse(updatedBytes.toString())).toEqual({
        schema_version: 1,
        x: 2,
      })

      release.resolve()
      expect((await pendingMove).outcome).toBe('aborted-target-appeared')
      expect(await fs.readFile(file)).toEqual(updatedBytes)
      expect(link.mock.calls).toEqual([
        [updateTemp, file],
        [moveTemp, file],
      ])
      expect(rename).not.toHaveBeenCalled()
      await expect(fs.lstat(updateTemp)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(fs.lstat(moveTemp)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      release.resolve()
      await pendingMove
    }
  })
})
