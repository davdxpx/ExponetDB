import { stripComments } from './css.ts'

export interface Block {
  /** The enclosing at-rule prelude (for example `@media (prefers-color-scheme: dark)`). */
  readonly media: string | undefined
  readonly selector: string
  readonly decls: ReadonlyMap<string, string>
}

function splitDeclarations(body: string): Map<string, string> {
  const decls = new Map<string, string>()
  let depth = 0
  let quote = ''
  let start = 0
  const flush = (end: number): void => {
    const piece = body.slice(start, end).trim()
    const colon = piece.indexOf(':')
    if (colon > 0) {
      decls.set(
        piece.slice(0, colon).trim(),
        piece
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, ' '),
      )
    }
  }
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i)
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1
    } else if (ch === ';' && depth === 0) {
      flush(i)
      start = i + 1
    }
  }
  flush(body.length)
  return decls
}

function parseLevel(css: string, media: string | undefined, out: Block[]): void {
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    const semi = css.indexOf(';', i)
    if (open === -1 || (semi !== -1 && semi < open)) {
      if (semi === -1) return
      i = semi + 1
      continue
    }
    const prelude = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      const ch = css.charAt(j)
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      j += 1
    }
    const inner = css.slice(open + 1, j - 1)
    if (prelude.startsWith('@media')) {
      parseLevel(inner, prelude, out)
    } else if (!prelude.startsWith('@')) {
      out.push({ media, selector: prelude.replace(/\s+/g, ' '), decls: splitDeclarations(inner) })
    }
    i = j
  }
}

/** Style rules of a stylesheet (one level of @media nesting), comments removed. */
export function parseBlocks(css: string): Block[] {
  const out: Block[] = []
  parseLevel(stripComments(css), undefined, out)
  return out
}

/** Every custom property declared in a stylesheet (`--name:`), comments removed. */
export function declaredProperties(css: string): Set<string> {
  const names = new Set<string>()
  for (const m of stripComments(css).matchAll(/(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)) {
    names.add(m[1] as string)
  }
  return names
}

/** Every `var(--name` reference of a stylesheet, comments removed. */
export function referencedVariables(css: string): Set<string> {
  const names = new Set<string>()
  for (const m of stripComments(css).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    names.add(m[1] as string)
  }
  return names
}
