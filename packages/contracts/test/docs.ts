import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (the directory that contains exponetdb-docs). */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'exponetdb-docs'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('repository root not found')
    }
    dir = parent
  }
}

export function readDoc(relative: string): string {
  return readFileSync(join(repoRoot(), 'exponetdb-docs', relative), 'utf8')
}

export function readRepoFile(relative: string): string {
  return readFileSync(join(repoRoot(), relative), 'utf8')
}

/** Text of the section that starts with the given heading line, up to the next heading of the same or higher level. */
export function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start < 0) {
    throw new Error(`heading not found: ${heading}`)
  }
  const level = heading.match(/^#+/)?.[0].length ?? 1
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && (l.match(/^#+/)?.[0].length ?? 9) <= level,
  )
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

/** Rows of Markdown tables as arrays of trimmed cells. */
export function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
    .map((l) =>
      l
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim()),
    )
}
