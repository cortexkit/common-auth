import { expect, test } from 'bun:test'

async function probe(mode: string) {
  const child = Bun.spawn(
    [process.execPath, 'test/fs/changing-lock-create-probe.mjs', mode],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(`${mode} failed\n${stdout}\n${stderr}`)
  expect(stderr).toBe('')
  return JSON.parse(stdout)
}

test('lease release retries access-denied marker creates while its holder deletes it', async () => {
  expect(await probe('marker')).toEqual({ deletionRaces: 1 })
})

test('acquisition retries access-denied lock creates while its holder releases', async () => {
  expect(await probe('lock')).toEqual({ deletionRaces: 2 })
})

test('persistent create code 5 preserves the first error without eviction under acquire bounds', async () => {
  expect(await probe('persistent')).toEqual({ persistent: 4 })
})

test('persistent marker create code 5 preserves the first error through the release deadline without unlink', async () => {
  expect(await probe('release')).toEqual({ persistent: 1 })
}, 10_000) // Release's existing marker TTL plus recovery deadline is six seconds.

test('unrelated create refusals still fail immediately and clean only our failed owner directory', async () => {
  expect(await probe('refused')).toEqual({ refused: 9 })
})

test('renewal retries a busy marker create while its lease remains verified', async () => {
  expect(await probe('renew')).toEqual({ renewed: true })
})
