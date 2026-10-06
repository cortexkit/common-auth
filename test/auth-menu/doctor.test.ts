import { beforeEach, describe, expect } from 'bun:test'
import { runAccountMenu } from '../../src/auth-menu/accounts.js'
import {
  DOCTOR_CHECK_FAILED,
  type DoctorCheck,
  doctorAction,
  runDoctorChecks,
} from '../../src/auth-menu/doctor.js'
import { runMenu } from '../../src/auth-menu/menu.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { oauth, type Scenario, scenario } from '../store/helpers.js'
import { choose, fakeTerminal, NO, YES } from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

let s: Scenario
beforeEach(async () => {
  s = await scenario('auth-menu-doctor-')
})
afterEach(() => s.cleanup())

const other = { id: 'other', label: 'Other', run: () => {} }

describe('auth doctor', () => {
  test('doctor applies only the repairs the operator chose', async () => {
    const applied: string[] = []
    const repair = (name: string) => ({
      label: `fix ${name}`,
      apply: () => {
        applied.push(name)
      },
    })
    const checks: DoctorCheck[] = [
      {
        id: 'first',
        run: () => [
          { code: 'one', message: 'Problem one.', repair: repair('one') },
          { code: 'note', message: 'Just a note.' },
        ],
      },
      {
        id: 'second',
        run: async () => [
          { code: 'two', message: 'Problem two.', repair: repair('two') },
          { code: 'three', message: 'Problem three.', repair: repair('three') },
        ],
      },
    ]
    const fake = fakeTerminal([...choose(0), ...NO, ...YES, ...NO])

    await runMenu({
      title: 'Example accounts',
      actions: [doctorAction({ checks }), other],
      terminal: fake.terminal,
    })

    expect(applied).toEqual(['two'])
    const text = fake.text()
    expect(text).toContain('- Problem one. (repair available)\n')
    expect(text).toContain('- Just a note.\n')
    expect(text).toContain('Apply repair: fix three?')
    expect(text).toContain('Applied 1 of 3 repair(s).')
  })

  test('declining Apply repairs leaves both files byte-unchanged', async () => {
    const store = s.open()
    await store.add({ id: 'a', credential: oauth('refresh-a') })
    const before = await s.bytes()
    const fake = fakeTerminal([...choose(5), ...NO])

    await runAccountMenu({
      title: 'Example accounts',
      store,
      terminal: fake.terminal,
      login: {
        begin: async () => {
          throw new Error('no login expected')
        },
      },
      doctor: [
        {
          id: 'disable-a',
          run: () => [
            {
              code: 'a-is-broken',
              message: 'Account a is broken.',
              accountId: 'a',
              repair: {
                label: 'disable account a',
                apply: async () => {
                  await store.disable('a', 'repaired by the doctor')
                },
              },
            },
          ],
        },
      ],
    })

    expect(fake.text()).toContain('Apply repair: disable account a?')
    expect(fake.text()).toContain('Applied 0 of 1 repair(s).')
    expect(await s.bytes()).toEqual(before)
  })

  test('a doctor check that throws becomes a finding beside the others', async () => {
    const report = await runDoctorChecks([
      {
        id: 'broken',
        run: () => {
          throw new Error('cannot read')
        },
      },
      { id: 'fine', run: () => [{ code: 'seen', message: 'Seen.' }] },
    ])

    expect(report.findings.map((finding) => finding.code)).toEqual([
      DOCTOR_CHECK_FAILED,
      'seen',
    ])
    expect(report.findings[0]?.message).toBe('Check broken failed: cannot read')
  })
})
