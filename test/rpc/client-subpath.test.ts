import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

// Every module the built file loads at runtime, following relative imports.
// Type-only imports are erased by the compiler, so only real loads remain.
function runtimeGraph(entry: string): string[] {
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/g,
    )) {
      const specifier = match[1]
      if (specifier) visit(resolve(dirname(file), specifier))
    }
    for (const match of source.matchAll(
      /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g,
    )) {
      const specifier = match[1]
      if (specifier) visit(resolve(dirname(file), specifier))
    }
  }
  visit(join(root, entry))
  return [...seen].map((file) => file.slice(root.length)).sort()
}

test('./rpc/client loads only the client and port-file modules', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  expect(pkg.exports['./rpc/client']).toEqual({
    types: './dist/rpc/client.d.ts',
    import: './dist/rpc/client.js',
  })
  expect(runtimeGraph('dist/rpc/client.js')).toEqual([
    'dist/rpc/client.js',
    'dist/rpc/port-file.js',
    'dist/rpc/rpc-client.js',
  ])
})

test('./rpc/client exports the same client functions as ./rpc', async () => {
  const client = await import(join(root, 'dist/rpc/client.js'))
  const full = await import(join(root, 'dist/rpc/index.js'))
  expect(Object.keys(client).sort()).toEqual([
    'DEFAULT_RPC_TIMEOUT_MS',
    'createRpcClient',
    'discoverPortFile',
  ])
  for (const name of Object.keys(client)) expect(client[name]).toBe(full[name])
})
