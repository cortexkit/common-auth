import { writeFile } from 'node:fs/promises'

// Keep a missing notification alive until the parent test cancels and kills us.
const keepAlive = setInterval(() => {}, 1_000)
const set = globalThis.setTimeout
const clear = globalThis.clearTimeout
const pending = new Set<ReturnType<typeof setTimeout>>()
let cleared = 0
// The fresh child imports only after capture: the primitive binds these globals.
globalThis.setTimeout = ((
  callback: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
) => {
  const timer = set(() => {
    pending.delete(timer)
    callback(...args)
  }, ms)
  pending.add(timer)
  return timer
}) as typeof setTimeout
globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
  if (pending.delete(timer as ReturnType<typeof setTimeout>)) cleared++
  clear(timer as ReturnType<typeof setTimeout>)
}) as typeof clearTimeout
const { acquireRefreshFileLock } = await import(
  '../../src/fs/refresh-file-lock.js'
)
globalThis.setTimeout = set
globalThis.clearTimeout = clear

let scheduled!: () => void
let cancelled!: () => void
const schedule = new Promise<void>((resolve) => {
  scheduled = resolve
})
const cancel = new Promise<void>((resolve) => {
  cancelled = resolve
})
let ticks = 0
const onStepValues: string[] = []
const path = process.argv[2]
if (!path) throw new Error('Expected the parent test scratch path')
const lock = await acquireRefreshFileLock({
  path,
  name: 'cancel',
  ttlMs: 120_000,
  renew: true,
  renewIntervalMs: 60_000,
  onStep(step) {
    onStepValues.push(step)
    if (step === 'renewal-finished') ticks++
  },
  onRenewalTimer(event) {
    if (event === 'scheduled') scheduled()
    if (event === 'cancelled') cancelled()
    if (process.argv[3] === 'throw') throw new Error('observer throw')
    if (process.argv[3] === 'reject')
      return Promise.reject(new Error('observer rejection'))
    if (process.argv[3] === 'pending') return new Promise<void>(() => {})
  },
})
if (!lock) throw new Error('Expected a fresh lock')
try {
  await schedule
  const afterSchedule = { pending: pending.size, cleared, ticks }
  await writeFile(
    `${path}.cancel.lock`,
    JSON.stringify({ ownerId: 'successor', expiresAt: Date.now() + 120_000 }),
  )
  const beforeLoss = { pending: pending.size, cleared, ticks }
  let ownershipError = ''
  try {
    await lock.assertOwned()
  } catch (error) {
    ownershipError = (error as Error).name
  }
  await cancel
  const afterCancel = { pending: pending.size, cleared, ticks }
  console.log(
    JSON.stringify({
      afterSchedule,
      beforeLoss,
      afterCancel,
      ownershipError,
      onStepValues,
      loss: await lock.whenLost(),
    }),
  )
} finally {
  await lock.release()
  for (const timer of pending) clear(timer)
  clearInterval(keepAlive)
}
