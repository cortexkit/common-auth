import { type Node, type ParseError, parseTree } from 'jsonc-parser'

interface ParsedText {
  /** Text without the optional leading BOM; tree offsets refer to this text. */
  text: string
  hasBom: boolean
  tree: Node | undefined
}

export interface ParsedSettings extends ParsedText {
  parseable: true
  value: Record<string, unknown>
  duplicateKeyPaths: string[][]
  hasDuplicates: boolean
}

export interface UnparseableSettings extends ParsedText {
  parseable: false
  errors: ParseError[]
}

export type SettingsParseResult = ParsedSettings | UnparseableSettings

/** Define own data properties so JSON keys never invoke prototype setters. */
export function defineSettingsKey(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/** Convert in document order, retaining the last occurrence of a repeated key. */
export function settingsValueFromTree(
  node: Node,
  onDuplicate: (keyPath: string[]) => void = () => {},
  keyPath: string[] = [],
): unknown {
  if (node.type === 'object') {
    const value: Record<string, unknown> = {}
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? []
      if (!keyNode || !valueNode) continue
      const key = keyNode.value as string
      const path = [...keyPath, key]
      if (Object.hasOwn(value, key)) onDuplicate(path)
      defineSettingsKey(
        value,
        key,
        settingsValueFromTree(valueNode, onDuplicate, path),
      )
    }
    return value
  }
  if (node.type === 'array') {
    return (node.children ?? []).map((child, index) =>
      settingsValueFromTree(child, onDuplicate, [...keyPath, String(index)]),
    )
  }
  return node.value
}

export function parseSettings(source: string): SettingsParseResult {
  const hasBom = source.startsWith('\uFEFF')
  const text = hasBom ? source.slice(1) : source
  // Do not use trim(): it would silently discard a second or misplaced BOM.
  if (/^[\x20\t\r\n]*$/.test(text)) {
    return {
      parseable: true,
      text,
      hasBom,
      tree: undefined,
      value: {},
      duplicateKeyPaths: [],
      hasDuplicates: false,
    }
  }
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })
  if (errors.length || tree?.type !== 'object') {
    return { parseable: false, text, hasBom, tree, errors }
  }
  const paths = new Map<string, string[]>()
  const value = settingsValueFromTree(tree, (path) => {
    paths.set(JSON.stringify(path), path)
  }) as Record<string, unknown>
  return {
    parseable: true,
    text,
    hasBom,
    tree,
    value,
    duplicateKeyPaths: [...paths.values()],
    hasDuplicates: paths.size > 0,
  }
}
