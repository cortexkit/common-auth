import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { makeRepoScratchDir } from './scratch.js'

const cases = [
  {
    kind: 'consumer',
    file: '../claustrum/consumer.test.ts',
    title: 'a peer replacing an account cannot leave its old route authorized',
    parkAfter: "const id = f.route(await f.consumer.refresh(), 'oauth:test')",
  },
  {
    kind: 'enrollment',
    file: '../claustrum/enrollment.test.ts',
    title:
      'blocks a retryable poll refusal whose code is protocol-terminal and stops re-polling',
    parkAfter: 'await expect(instance.reconcile()).resolves.toEqual(blocked)',
  },
  {
    kind: 'schema',
    file: '../store/schema.test.ts',
    title:
      'the unlocked legacy config read never observes a partial file during library writes',
    parkAfter: "await store.add({ id: 'seed', credential: oauth('r-seed') })",
  },
] as const

for (const entry of cases) {
  test(`${entry.kind} real runner timeout keeps resources alive through the original body and final assertions`, async () => {
    const dir = await makeRepoScratchDir(`lifetime-${entry.kind}-`)
    try {
      const original = new URL(entry.file, import.meta.url).pathname
      let source = await readFile(original, 'utf8')
      const declaration = `${entry.kind === 'schema' ? 'it' : 'test'}('${entry.title}', async () => {`
      const start = source.indexOf(declaration)
      const indent = entry.kind === 'consumer' ? '' : '  '
      const end = source.indexOf(`\n${indent}})`, start) + 1 + indent.length
      const park =
        source.indexOf(entry.parkAfter, start) + entry.parkAfter.length
      if (start < 0 || end <= start || park < start || park > end)
        throw new Error(`missing original resource body: ${entry.title}`)
      // The added delay makes Bun time out the copied test while its body is
      // still running. The copied resource test must finish every assertion
      // afterward; a toy fixture cannot prove its real cleanup ordering.
      source = `${source.slice(0, end + 1)}, 100${source.slice(end + 1)}`
      source =
        source.slice(0, end) +
        `\n__terminal = true; console.log('lifetime body terminal: ${entry.kind}');\n` +
        source.slice(end)
      source =
        source.slice(0, park) +
        '\nawait new Promise(resolve => setTimeout(resolve, 200));\n' +
        source.slice(park)
      source = source.replace(
        /(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
        (_match, prefix: string, _quote: string, path: string) =>
          `${prefix}${JSON.stringify(resolve(dirname(original), path))}`,
      )
      source +=
        "\nlet __terminal = false;\ntest('lifetime successor waits for original final assertions', () => { expect(__terminal).toBe(true) });\n"
      // Store tests use it rather than test as their registration name.
      if (entry.kind === 'schema')
        source = source.replace(
          "\ntest('lifetime successor",
          "\nit('lifetime successor",
        )
      const path = join(dir, 'lifetime.test.ts')
      await writeFile(path, source)
      const child = spawn(
        process.execPath,
        ['test', path, '-t', `${entry.title}|lifetime successor`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      expect(code).toBe(1)
      expect(output).toContain('timed out after 100ms')
      expect(output).toContain(`lifetime body terminal: ${entry.kind}`)
      expect(output).toContain(
        '(pass) lifetime successor waits for original final assertions',
      )
      expect(output).toContain('1 pass')
      expect(output).toContain('1 fail')
      expect(output).not.toContain('Unhandled error')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
