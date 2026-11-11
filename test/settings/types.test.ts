import { expect, expectTypeOf, test } from 'bun:test'
import { defineSettings } from '../../src/settings/define.js'
import { oneOf } from '../../src/settings/descriptors.js'
import { openSettings } from '../../src/settings/handle.js'

test('settings get preserves literal unions and rejects undeclared names', async () => {
  const handle = openSettings(
    defineSettings({
      plugin: 'types-test',
      settings: {
        routing_mode: { value: oneOf(['a', 'b']), default: 'a', hosts: 'both' },
      },
    }),
    {
      file: '/unused/settings.jsonc',
      log: { warn() {}, info() {} },
      separateInstall: true,
    },
  )
  const result = handle.get('routing_mode', { host: 'opencode' })
  expectTypeOf(result).toEqualTypeOf<Promise<'a' | 'b'>>()
  expectTypeOf(await result).toEqualTypeOf<'a' | 'b'>()
  // @ts-expect-error No setting named typo is declared.
  await expect(handle.get('typo', { host: 'opencode' })).rejects.toThrow(
    TypeError,
  )
  expect(handle.report()).toEqual([])
})
