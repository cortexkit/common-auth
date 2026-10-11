import { readFile } from 'node:fs/promises'
for (const arch of ['x64', 'arm64']) {
  const path = new URL(`../prebuilds/private-files-win32-${arch}.node`, import.meta.url)
  const bytes = await readFile(path)
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`Missing PE binary: ${arch}`)
  const offset = bytes.readUInt32LE(0x3c)
  const expected = arch === 'x64' ? 0x8664 : 0xaa64
  if (bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== expected) {
    throw new Error(`Wrong PE machine architecture: ${arch}`)
  }
  console.log(`Verified packaged PE prebuild: win32-${arch}`)
}
