export interface ImportReference {
  specifier: string
  start: number
  end: number
}

/** Locate module strings without treating comments or ordinary strings as imports. */
export function parseImports(
  code: string,
  filename: string,
): ImportReference[] {
  const tokens: { text: string; start: number; end: number }[] = []
  let position = 0
  const push = (start: number) =>
    tokens.push({ text: code.slice(start, position), start, end: position })
  const scan = (templateExpression = false): void => {
    let depth = 0
    while (position < code.length) {
      const start = position
      const character = code.charAt(position)
      if (/\s/.test(character)) {
        position++
        continue
      }
      if (code.startsWith('//', position)) {
        position = code.indexOf('\n', position)
        if (position < 0) position = code.length
        continue
      }
      if (code.startsWith('/*', position)) {
        const end = code.indexOf('*/', position + 2)
        position = end < 0 ? code.length : end + 2
        continue
      }
      if (character === '"' || character === "'") {
        position++
        while (position < code.length) {
          const next = code[position++]
          if (next === '\\') position++
          else if (next === character) break
        }
        push(start)
        continue
      }
      if (character === '`') {
        position++
        push(start)
        while (position < code.length) {
          if (code[position] === '\\') {
            position += 2
            continue
          }
          if (code[position] === '`') {
            position++
            break
          }
          if (code.startsWith('${', position)) {
            position += 2
            scan(true)
            continue
          }
          position++
        }
        continue
      }
      // A regex body can contain import-shaped text that is not executable code.
      const previous = tokens.at(-1)?.text
      if (
        character === '/' &&
        (!previous ||
          [
            '=',
            '(',
            '[',
            '{',
            ',',
            ':',
            ';',
            'return',
            '=>',
            '!',
            '&&',
            '||',
          ].includes(previous))
      ) {
        position++
        let inClass = false
        while (position < code.length) {
          const next = code[position++]
          if (next === '\\') {
            position++
            continue
          }
          if (next === '[') inClass = true
          if (next === ']') inClass = false
          if (next === '/' && !inClass) break
        }
        while (/[a-z]/i.test(code[position] ?? '') && position < code.length)
          position++
        push(start)
        continue
      }
      if (templateExpression && character === '}' && depth === 0) {
        position++
        return
      }
      if (character === '{') depth++
      if (character === '}') depth--
      if (/[\w$]/.test(character)) {
        position++
        while (position < code.length && /[\w$]/.test(code.charAt(position)))
          position++
      } else position++
      push(start)
    }
  }
  scan()
  const references: ImportReference[] = []
  const add = (token: (typeof tokens)[number]) => {
    if (!/^["']/.test(token.text)) return
    const specifier = token.text.slice(1, -1).replace(/\\(['"\\])/g, '$1')
    references.push({ specifier, start: token.start, end: token.end })
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token.text !== 'import' && token.text !== 'export') continue
    if (tokens[i - 1]?.text === '.') continue
    const next = tokens[i + 1]
    if (!next || next.text === '.') continue
    if (token.text === 'import' && next.text === '(') {
      const argument = tokens[i + 2]
      if (
        !argument ||
        !/^["']/.test(argument.text) ||
        ![')', ','].includes(tokens[i + 3]?.text ?? '')
      ) {
        throw new Error(
          `Non-literal dynamic import in ${filename}: ${code.slice(next.end, code.indexOf(')', next.end))}`,
        )
      }
      add(argument)
    } else if (/^["']/.test(next.text)) {
      add(next)
    } else if (
      ['{', '*', 'type'].includes(next.text) ||
      token.text === 'import'
    ) {
      for (let j = i + 1; j < tokens.length; j++) {
        const candidate = tokens[j]
        if (!candidate) continue
        if (
          candidate.text === ';' ||
          candidate.text === 'import' ||
          candidate.text === 'export'
        )
          break
        if (candidate.text === 'from') {
          const source = tokens[j + 1]
          if (source) add(source)
          break
        }
      }
    }
  }
  return references
}

export function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.includes(':')
  )
}
