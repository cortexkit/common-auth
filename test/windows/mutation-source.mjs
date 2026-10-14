import { readFile, writeFile } from 'node:fs/promises'

export function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n')
}

export function applyMutation(source, oldText, newText, id = 'fixture') {
  const normalized = normalizeLineEndings(source)
  const anchor = normalizeLineEndings(oldText)
  const first = normalized.indexOf(anchor)
  if (!anchor.length || first < 0 || normalized.lastIndexOf(anchor) !== first)
    throw new Error(`Mutation anchor must match exactly once: ${id}`)
  const mutated = normalized.replace(anchor, normalizeLineEndings(newText))
  return source.includes('\r\n') ? mutated.replace(/\n/g, '\r\n') : mutated
}

if (import.meta.main) {
  const [rowsPath, id] = process.argv.slice(2)
  const rows = JSON.parse(await readFile(rowsPath, 'utf8'))
  const row = rows.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`Unknown mutation: ${id}`)
  const source = await readFile(row.file, 'utf8')
  await writeFile(row.file, applyMutation(source, row.old, row.new, row.id))
  console.log(`Applied unique normalized mutation: ${id}`)
}
