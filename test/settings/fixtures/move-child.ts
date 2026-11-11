import { parse } from 'jsonc-parser'
import { defineSettings } from '../../../src/settings/define.js'
import { integer } from '../../../src/settings/descriptors.js'
import {
  moveSettingsOnce,
  setSettingsMoveStepHookForTest,
} from '../../../src/settings/move.js'

const [target, source] = process.argv.slice(2)
if (!target || !source)
  throw new Error('Expected target and legacy source paths')

setSettingsMoveStepHookForTest(async (step, { temp }) => {
  if (step !== 'staged') return
  console.log(JSON.stringify({ step, temp }))
  // Keep the process alive while the parent verifies the staged file and kills it.
  await new Promise(() => setInterval(() => {}, 1_000))
})

const result = await moveSettingsOnce({
  definition: defineSettings({
    plugin: 'example',
    settings: { count: { value: integer(), default: 0, hosts: 'both' } },
  }),
  target,
  sources: [
    {
      path: source,
      host: 'opencode',
      locks: [{ path: source, name: 'preferences' }],
      read: (text) => (parse(text) as { count: number }).count,
    },
  ],
  separateInstall: false,
  fence: () => true,
  map: (legacy) => ({
    entries: legacy.flatMap((source, index) =>
      source.present
        ? [{ source: index, setting: 'count', value: source.value }]
        : [],
    ),
    unmapped: [],
  }),
  log: { warn: () => {}, info: () => {} },
})
throw new Error(
  `Move unexpectedly completed before being killed: ${result.outcome}`,
)
