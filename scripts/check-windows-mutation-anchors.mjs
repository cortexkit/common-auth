import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMutation, normalizeLineEndings } from '../test/windows/mutation-source.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function checkWindowsMutationAnchors(rowsPath = 'test/windows/mutation-rows.json') {
  const rows = JSON.parse(await readFile(resolve(root, rowsPath), 'utf8'))
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No Windows mutation rows')
  for (const row of rows) {
    const committed = execFileSync('git', ['show', `HEAD:${row.file}`], {
      cwd: root,
      encoding: 'utf8',
    })
    applyMutation(committed, row.old, row.new, row.id)
    const crlf = normalizeLineEndings(committed).replace(/\n/g, '\r\n')
    applyMutation(crlf, row.old, row.new, row.id)
  }
  return { rows: rows.length, checks: rows.length * 2 }
}

if (import.meta.main) {
  const result = await checkWindowsMutationAnchors(process.argv[2])
  console.log(`Windows mutation anchors ok (${result.rows} rows, ${result.checks} committed-source/EOL checks)`)
}
