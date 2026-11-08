import { expectTypeOf, test } from 'bun:test'
import type { SidebarWindowPart } from '@cortexkit/opencode-sidebar'
import type { QuotaWindowPart } from '../../src/quota/index.js'

test('quota window parts remain assignable to the shared sidebar rows', () => {
  expectTypeOf<QuotaWindowPart>().toExtend<SidebarWindowPart>()
})
