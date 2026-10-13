import { AREA_LABELS, AREAS, type Area, locate, parseMeta } from './meta.ts'

/**
 * The agent-readable index of the design system (order Phase 6): `llms.txt`
 * lists every page with its one-sentence description and the path of its
 * Markdown export; each page is exported as Markdown with its live demos
 * replaced by a line naming the demo. Coding agents read these before
 * building a screen. Pure functions over the MDX sources, run by the build.
 */
export interface MdxSource {
  /** Relative to `src/content/`, e.g. `guidance/forms.mdx`. */
  readonly path: string
  readonly source: string
}

export interface IndexFile {
  readonly fileName: string
  readonly source: string
}

/**
 * The `meta` export of an MDX source, read as data without running it. It is
 * written one property per line with a JSON value:
 *
 *     export const meta = {
 *       title: "Forms",
 *       description: "How forms are laid out, validated and submitted.",
 *       order: 2,
 *     }
 *
 * Anything else fails with the file's name.
 */
export function readMeta(source: string, where: string) {
  const lines = source.split('\n')
  const start = lines.indexOf('export const meta = {')
  if (start < 0) throw new Error(`${where}: export const meta = { is missing`)
  const value: Record<string, unknown> = {}
  for (const line of lines.slice(start + 1)) {
    if (line === '}') return parseMeta(value, where)
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*): (.+?),?$/.exec(line)
    if (m?.[1] === undefined || m[2] === undefined) {
      throw new Error(`${where}: meta lines are "  key: <JSON value>,"`)
    }
    try {
      value[m[1]] = JSON.parse(m[2]) as unknown
    } catch {
      throw new Error(`${where}: meta.${m[1]} is not a JSON value (use double quotes)`)
    }
  }
  throw new Error(`${where}: meta has no closing "}" line`)
}

/** MDX to Markdown: `import` and `export` statements dropped, `<Demo id="…" />` replaced by a line naming the demo. */
export function toMarkdown(source: string): string {
  const lines: string[] = []
  let inStatement = false
  for (const line of source.split('\n')) {
    if (inStatement) {
      // A multi-line statement ends at its closing brace line.
      if (/^\}/.test(line)) inStatement = false
      continue
    }
    if (/^(import|export)\s/.test(line)) {
      inStatement = /\{\s*$/.test(line)
      continue
    }
    lines.push(
      line.replace(
        /<Demo\s+id="([a-z0-9/.-]+)"\s*\/>/g,
        (_, id: string) => `> Live demo \`${id}\` (in the design-system app).`,
      ),
    )
  }
  return `${lines.join('\n').trim()}\n`
}

export function buildMarkdownIndex(sources: readonly MdxSource[]): readonly IndexFile[] {
  const pages = sources.map((file) => {
    const { area, slug } = locate(file.path)
    const meta = readMeta(file.source, file.path)
    return { area, slug, meta, markdown: toMarkdown(file.source) }
  })
  const byArea = (area: Area) =>
    pages
      .filter((p) => p.area === area)
      .sort(
        (a, b) =>
          (a.meta.order ?? Number.MAX_SAFE_INTEGER) - (b.meta.order ?? Number.MAX_SAFE_INTEGER) ||
          a.meta.title.localeCompare(b.meta.title, 'en-US'),
      )
  const index = [
    '# ExponetDB design system',
    '',
    '> Guidance, components and patterns of the ExponetDB Web App. Read the guidance and the page of each component or pattern before building a screen; the rules here restate exponetdb-docs/11-ui/design-system.md.',
    '',
  ]
  for (const area of AREAS) {
    const list = byArea(area)
    if (list.length === 0) continue
    index.push(`## ${AREA_LABELS[area]}`, '')
    for (const page of list) {
      index.push(
        `- [${page.meta.title}](md/${page.area}/${page.slug}.md): ${page.meta.description}`,
      )
    }
    index.push('')
  }
  return [
    { fileName: 'llms.txt', source: `${index.join('\n').trim()}\n` },
    ...pages.map((page) => ({
      fileName: `md/${page.area}/${page.slug}.md`,
      source: page.markdown,
    })),
  ]
}
