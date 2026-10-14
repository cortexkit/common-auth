import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function checkPrivateFilesExternal(root = 'dist') {
  let files = 0
  let imports = 0
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.js')) {
        files++
        const source = await readFile(path, 'utf8')
        if (
          source.includes('private-files-win32-') ||
          source.includes('function loadPrivateFilesNative')
        ) {
          throw new Error(`private-files native loader was inlined: ${path}`)
        }
        // Plugins embed sidebar, logger and RPC modules in their TUI renderers.
        // A static import would make every renderer resolve and load
        // private-files at startup on every platform, so the package may only
        // be reached through the lazy import() that runs when a private-file
        // operation first needs it.
        if (
          /(?:from|import)\s*['"]@cortexkit\/private-files['"]/.test(source)
        ) {
          throw new Error(`private-files must be imported lazily: ${path}`)
        }
        imports += [
          ...source.matchAll(/import\(['"]@cortexkit\/private-files['"]\)/g),
        ].length
      }
    }
  }
  await walk(root)
  if (!files || !imports)
    throw new Error(
      'built common-auth must retain the external private-files import',
    )
  return { files, imports }
}

if (import.meta.main) {
  const result = await checkPrivateFilesExternal()
  console.log(
    `private-files external ok (${result.files} emitted files, ${result.imports} bare imports checked)`,
  )
}
