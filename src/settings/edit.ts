import { isDeepStrictEqual } from 'node:util'
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  type Node,
} from 'jsonc-parser'
import type { SettingDeclaration, SettingsDefinition } from './define.js'
import {
  isJsonObject,
  type ValueDescriptor,
  validateValue,
} from './descriptors.js'
import { type ParsedSettings, parseSettings } from './parse.js'
import { SettingsRefusal } from './refusal.js'

export type SettingsEdit = {
  setting: string
  path?: readonly string[]
} & ({ value: unknown; remove?: never } | { remove: true; value?: never })

export interface UpdateResult {
  outcome: 'updated' | 'unchanged'
}

interface EditContext {
  host: string
  model?: string
}

interface ResolutionUnit {
  path: string[]
  descriptor: ValueDescriptor
}

// jsonc-parser declares these scanner tokens as an ambient const enum, which
// cannot be imported as a value with verbatimModuleSyntax enabled.
const SyntaxKind = {
  CommaToken: 5,
  LineCommentTrivia: 12,
  BlockCommentTrivia: 13,
  Trivia: 15,
  EOF: 17,
} as const

function invalid(): never {
  throw new SettingsRefusal(
    'settings-invalid-value',
    'The settings edit does not match its declared value',
  )
}

function parseForEdit(text: string): ParsedSettings {
  const parsed = parseSettings(text)
  if (!parsed.parseable || parsed.hasDuplicates) {
    throw new SettingsRefusal(
      'settings-unparseable',
      'Settings must be an object without duplicate keys',
    )
  }
  return parsed
}

function descriptorAtPath(
  descriptor: ValueDescriptor,
  path: readonly string[],
): ValueDescriptor {
  let current = descriptor
  for (const key of path) {
    if (current.kind === 'object' && Object.hasOwn(current.fields, key)) {
      current = current.fields[key] as ValueDescriptor
    } else if (current.kind === 'record') {
      current = current.value
    } else {
      invalid()
    }
  }
  return current
}

function destination(
  declaration: SettingDeclaration,
  setting: string,
  value: unknown,
  { host, model }: EditContext,
): string[] {
  if (declaration.overrides !== undefined && isJsonObject(value)) {
    if (
      declaration.overrides.model &&
      model !== undefined &&
      model !== 'default' &&
      model !== 'opencode' &&
      model !== 'pi' &&
      Object.hasOwn(value, model)
    ) {
      return [setting, model]
    }
    if (
      declaration.overrides.host &&
      (host === 'opencode' || host === 'pi') &&
      Object.hasOwn(value, host)
    ) {
      return [setting, host]
    }
    return [setting, 'default']
  }
  return [setting]
}

function resolutionUnit(
  descriptor: ValueDescriptor,
  destination: string[],
  path: readonly string[],
): ResolutionUnit {
  let current = descriptor
  const unitPath = [...destination]
  for (const key of path) {
    // Records and lists resolve whole, even when the edit changes one leaf.
    if (current.kind === 'record' || current.kind === 'list') break
    current = descriptorAtPath(current, [key])
    unitPath.push(key)
  }
  return { path: unitPath, descriptor: current }
}

function checkPath(parsed: ParsedSettings, path: string[]): void {
  for (let length = 1; length < path.length; length++) {
    const node =
      parsed.tree && findNodeAtLocation(parsed.tree, path.slice(0, length))
    if (node && node.type !== 'object') invalid()
  }
}

/** Remove only the member's own tokens; intervening comment lines belong to neither neighbor. */
function removeMember(
  text: string,
  tree: Node | undefined,
  path: string[],
): string {
  const property = tree && findNodeAtLocation(tree, path)?.parent
  const parent = property?.parent
  if (property?.type !== 'property' || !parent?.children) return text

  const scanner = createScanner(text, false)
  const end = property.offset + property.length
  const index = parent.children.indexOf(property)
  const next = parent.children[index + 1]
  const followingEnd = next?.offset ?? parent.offset + parent.length - 1
  let comma: { start: number; end: number } | undefined
  scanner.setPosition(end)
  while (scanner.getPosition() < followingEnd) {
    const token = scanner.scan()
    if (token === SyntaxKind.CommaToken) {
      comma = { start: scanner.getTokenOffset(), end: scanner.getPosition() }
      break
    }
    if (token === SyntaxKind.EOF) break
  }
  if (!comma && index > 0) {
    const previous = parent.children[index - 1] as Node
    scanner.setPosition(previous.offset + previous.length)
    while (scanner.getPosition() < property.offset) {
      const token = scanner.scan()
      if (token === SyntaxKind.CommaToken) {
        comma = { start: scanner.getTokenOffset(), end: scanner.getPosition() }
        break
      }
      if (token === SyntaxKind.EOF) break
    }
  }

  let removeEnd = end
  scanner.setPosition(end)
  while (scanner.getPosition() < followingEnd) {
    const token = scanner.scan()
    if (token === SyntaxKind.Trivia || token === SyntaxKind.CommaToken) continue
    if (
      token !== SyntaxKind.LineCommentTrivia &&
      token !== SyntaxKind.BlockCommentTrivia
    )
      break
    removeEnd = scanner.getPosition()
    // A multiline trailing comment belongs to the member, but comments starting
    // on subsequent lines do not.
    if (/[\r\n]/.test(scanner.getTokenValue())) break
  }
  if (
    comma &&
    comma.start >= end &&
    !/[\r\n]/.test(text.slice(end, comma.start))
  ) {
    removeEnd = Math.max(removeEnd, comma.end)
  }

  const lineStart =
    Math.max(
      text.lastIndexOf('\n', property.offset - 1),
      text.lastIndexOf('\r', property.offset - 1),
    ) + 1
  let removeStart = property.offset
  const lineBreak = /^[\t ]*(\r\n|\r|\n)/.exec(text.slice(removeEnd))
  if (/^[\t ]*$/.test(text.slice(lineStart, property.offset)) && lineBreak) {
    removeStart = lineStart
    removeEnd += lineBreak[0].length
  }

  const edits = [
    { offset: removeStart, length: removeEnd - removeStart, content: '' },
  ]
  // The last member's comma can be separated from it by preserved comment lines.
  if (comma && (comma.start < removeStart || comma.start >= removeEnd)) {
    edits.push({
      offset: comma.start,
      length: comma.end - comma.start,
      content: '',
    })
  }
  return applyEdits(text, edits)
}

/** Pure JSONC edit engine; the writer owns locking, templates and durable I/O. */
export function applySettingsEdits(
  definition: SettingsDefinition,
  source: string,
  edits: readonly SettingsEdit[],
  context: EditContext,
): UpdateResult & { text: string } {
  // Validate the entire request before changing even the private working text.
  for (const edit of edits) {
    if (!Object.hasOwn(definition.settings, edit.setting)) invalid()
    const declaration = definition.settings[edit.setting] as SettingDeclaration
    if (
      edit.path !== undefined &&
      declaration.value.kind !== 'object' &&
      declaration.value.kind !== 'record'
    )
      invalid()
    const descriptor = descriptorAtPath(declaration.value, edit.path ?? [])
    if (edit.remove !== true && !validateValue(descriptor, edit.value))
      invalid()
  }

  const start = parseForEdit(source)
  let working = start
  const units: ResolutionUnit[] = []
  for (const edit of edits) {
    const declaration = definition.settings[edit.setting] as SettingDeclaration
    const base =
      edit.path !== undefined
        ? [edit.setting]
        : destination(
            declaration,
            edit.setting,
            working.value[edit.setting],
            context,
          )
    const path = [...base, ...(edit.path ?? [])]
    checkPath(working, path)
    units.push(resolutionUnit(declaration.value, base, edit.path ?? []))
    const node = working.tree && findNodeAtLocation(working.tree, path)
    let text: string
    if (edit.remove === true) {
      if (!node) continue
      text = removeMember(working.text, working.tree, path)
      let removed = parseForEdit(text)
      const remaining = removed.value[edit.setting]
      if (
        base.length === 2 &&
        isJsonObject(remaining) &&
        Object.keys(remaining).length === 0
      ) {
        text = removeMember(text, removed.tree, [edit.setting])
        removed = parseForEdit(text)
      }
      working = removed
    } else {
      if (node && isDeepStrictEqual(valueAt(working.value, path), edit.value))
        continue
      text = applyEdits(
        working.text,
        modify(working.text, path, edit.value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      )
      working = parseForEdit(text)
    }
  }
  for (const unit of units) {
    const node = working.tree && findNodeAtLocation(working.tree, unit.path)
    if (
      node &&
      !validateValue(unit.descriptor, valueAt(working.value, unit.path), {
        allowUnknownFields: true,
      })
    )
      invalid()
  }
  if (isDeepStrictEqual(start.value, working.value)) {
    return { outcome: 'unchanged', text: source }
  }
  return {
    outcome: 'updated',
    text: `${start.hasBom ? '\uFEFF' : ''}${working.text}`,
  }
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}
