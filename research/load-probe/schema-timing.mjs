// Natural-only phase tracing; do not inject workstation load with this script.
// Usage: bun research/load-probe/schema-timing.mjs tight|none|paced [runs]
import { readFile, readdir } from 'node:fs/promises'
import { oauth, scenario } from '../../test/store/helpers.ts'

const [mode = 'tight', runs = '5'] = process.argv.slice(2)
if (!['tight', 'none', 'paced'].includes(mode)) throw new Error('unknown mode')
for (let run = 1; run <= Number(runs); run++) {
  const s = await scenario('schema-timing-')
  let iterations = 0
  let stop = false
  let trace
  const read = async () => {
    JSON.parse(await readFile(s.configPath, 'utf8'))
    iterations++
  }
  const store = s.open({
    ...(mode === 'paced' ? { storeLocks: [] } : {}),
    onLockEvent: (event) => {
      if (trace) trace.events.push({ ...event, ms: performance.now() - trace.start })
    },
    onStep: async (step) => {
      if (trace) trace.steps[step] = performance.now() - trace.start
      if (step === 'before-config-write') {
        const names = await readdir(s.dir)
        if (names.filter((name) => /^openai-auth\.json\..+\.tmp$/.test(name)).length !== 1)
          throw new Error('expected exactly one config temp')
      }
      if (trace && mode === 'paced') {
        await read()
        if (step === 'before-config-write') trace.windowReads++
      }
    },
  })
  let reader = Promise.resolve()
  try {
    await store.add({ id: 'seed', credential: oauth('r-seed') })
    const start = performance.now()
    if (mode === 'tight') reader = (async () => {
      while (!stop) {
        await read()
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()
    const adds = []
    for (let index = 0; index < 20; index++) {
      trace = { start: performance.now(), events: [], steps: {}, windowReads: 0 }
      const before = iterations
      const add = store.add({ id: `r${index}`, credential: oauth(`r-${index}`) })
      if (mode === 'paced') await Promise.all([add, read()])
      else await add
      adds.push({ index, durationMs: performance.now() - trace.start, reads: iterations - before, ...trace })
    }
    console.log(JSON.stringify({ runtime: Bun.version, mode, run, totalMs: performance.now() - start, iterations, adds }))
  } finally {
    stop = true
    await reader
    s.cleanup()
  }
}
