import { execFile } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'

/** Compare the files npm actually publishes, not the manifest's glob patterns. */
export async function assertEmittedPublishList(
  packageRoot: string,
  destinationDir: string,
  emitted: readonly string[],
): Promise<void> {
  const { stdout } = await promisify(execFile)(
    'npm',
    ['pack', '--json', '--dry-run', '--ignore-scripts'],
    { cwd: packageRoot },
  )
  const packed = JSON.parse(stdout) as { files: { path: string }[] }[]
  const prefix = `${relative(resolve(packageRoot), resolve(destinationDir)).split('\\').join('/')}/`
  const packageInfo = packed[0]
  if (!packageInfo) throw new Error('npm pack returned no package')
  const actual = packageInfo.files
    .map((file) => file.path)
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .sort()
  const expected = [...emitted].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Published destination differs from emitted: ${JSON.stringify({ actual, expected })}`,
    )
}
