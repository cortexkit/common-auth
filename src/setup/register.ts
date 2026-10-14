import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  type ParseError,
  parse,
  parseTree,
} from 'jsonc-parser'
import { defaultCommandRunner, runResolvedCommand } from './command-runner.js'
import { writeHostConfigAtomic } from './config-write.js'
import { defaultSetupFileSystem } from './detect.js'
import { setupPaths } from './paths.js'
import type { OpenCodeGeneration, SetupIO, SetupPlugin } from './types.js'

export interface PlannedWrite {
  path: string
  content: string
  changed: boolean
}

function packageOf(value: unknown): string | null {
  const entry =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value[0]
        : value && typeof value === 'object' && 'package' in value
          ? value.package
          : null
  if (typeof entry !== 'string') return null
  const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0)
  return at < 0 ? entry : entry.slice(0, at)
}

function removeArrayEntry(text: string, key: string, index: number): string {
  const tree = parseTree(text)
  const array = tree && findNodeAtLocation(tree, [key])
  const nodes = array?.children ?? []
  const node = nodes[index]
  if (!node || !array) throw new Error('Invalid plugin array edit.')
  const edits = [{ offset: node.offset, length: node.length, content: '' }]
  const removeComma = (start: number, end: number) => {
    const scanner = createScanner(text.slice(start, end), true)
    scanner.scan()
    if (text[start + scanner.getTokenOffset()] === ',')
      edits.push({
        offset: start + scanner.getTokenOffset(),
        length: 1,
        content: '',
      })
  }
  // Delete punctuation separately so comments beside other entries are not removed.
  if (index === nodes.length - 1) {
    const previous = nodes[index - 1]
    if (previous) removeComma(previous.offset + previous.length, node.offset)
    removeComma(node.offset + node.length, array.offset + array.length - 1)
  } else
    removeComma(
      node.offset + node.length,
      nodes[index + 1]?.offset ?? node.offset + node.length,
    )
  return applyEdits(text, edits)
}

/** Edit only array entries so unrelated JSONC text, including comments, survives. */
export function updatePluginConfig(
  text: string,
  key: 'plugin' | 'plugins',
  pkg: string,
  version: string,
): string {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (
    errors.length ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    throw new Error('Invalid OpenCode config; refusing to overwrite it.')
  const options = {
    formattingOptions: {
      insertSpaces: !/^\t+/m.test(text),
      tabSize: /^([ ]+)"/m.exec(text)?.[1]?.length ?? 2,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    },
  }
  let output = text
  const array: unknown = value[key]
  if (array !== undefined && !Array.isArray(array))
    throw new Error(`OpenCode ${key} must be an array.`)
  const entries: unknown[] = Array.isArray(array) ? [...array] : []
  const matches = entries.flatMap((entry, index) =>
    packageOf(entry) === pkg ? [index] : [],
  )
  const entry = `${pkg}@${version}`
  if (!matches.length) {
    output = applyEdits(
      output,
      modify(
        output,
        array === undefined ? [key] : [key, entries.length],
        array === undefined ? [entry] : entry,
        options,
      ),
    )
  } else {
    const first = matches[0] as number
    const previous = entries[first]
    // Preserve options in OpenCode's [package, options] and { package, options } entries.
    const replacement = Array.isArray(previous)
      ? [entry, ...previous.slice(1)]
      : previous && typeof previous === 'object'
        ? { ...previous, package: entry }
        : entry
    if (JSON.stringify(previous) !== JSON.stringify(replacement))
      output = applyEdits(
        output,
        modify(output, [key, first], replacement, options),
      )
    for (const index of matches.slice(1).reverse())
      output = removeArrayEntry(output, key, index)
  }
  const other = key === 'plugin' ? 'plugins' : 'plugin'
  if (Array.isArray(value[other])) {
    const otherEntries: unknown[] = value[other]
    for (let index = otherEntries.length - 1; index >= 0; index--) {
      if (packageOf(otherEntries[index]) === pkg)
        output = removeArrayEntry(output, other, index)
    }
  }
  return output
}

export function planOpenCodeRegistration(
  plugin: SetupPlugin,
  generation: OpenCodeGeneration,
  io: SetupIO = {},
): PlannedWrite[] {
  const fs = io.fs ?? defaultSetupFileSystem
  const { path, opencode } = setupPaths(io)
  const key = generation === '2' ? 'plugins' : 'plugin'
  const names = generation === '2' ? ['opencode'] : ['opencode', 'tui']
  return names.map((name) => {
    const jsonc = path.join(opencode, `${name}.jsonc`)
    const json = path.join(opencode, `${name}.json`)
    const file = fs.exists(jsonc) ? jsonc : fs.exists(json) ? json : jsonc
    const exists = fs.exists(file)
    const before = exists
      ? fs.readText(file)
      : `${JSON.stringify({ $schema: `https://opencode.ai/${name === 'tui' ? 'tui' : 'config'}.json` }, null, 2)}\n`
    const content = updatePluginConfig(
      before,
      key,
      plugin.packages.opencode,
      plugin.version,
    )
    return { path: file, content, changed: !exists || content !== before }
  })
}

export async function registerOpenCode(
  writes: readonly PlannedWrite[],
  beforeWrite?: () => Promise<void>,
): Promise<void> {
  for (const write of writes) {
    if (!write.changed) continue
    await beforeWrite?.()
    await writeHostConfigAtomic(write.path, write.content, {
      beforeRename: beforeWrite,
    })
  }
}

export async function registerPi(
  plugin: SetupPlugin,
  executable: string,
  io: SetupIO = {},
): Promise<void> {
  const { platform, env } = setupPaths(io)
  const result = await runResolvedCommand(
    io.runner ?? defaultCommandRunner,
    platform,
    executable,
    ['install', `npm:${plugin.packages.pi}@${plugin.version}`],
    env,
  )
  if (result.exitCode !== 0)
    throw new Error(
      'Pi install failed; run pi install after checking your npm connection.',
    )
}
