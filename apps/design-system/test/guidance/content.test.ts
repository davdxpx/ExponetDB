import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readMeta, toMarkdown } from '../../src/content/markdown-export.ts'
import { PAGES } from '../../src/content/registry.ts'
import { DEMOS } from '../../src/demos/registry.ts'

// Built from two halves so that this file does not contain the name it forbids.
const ASSISTANT_NAME = new RegExp(['cla', 'ude'].join(''), 'i')

const here = dirname(fileURLToPath(import.meta.url))
const contentDir = join(here, '../../src/content/guidance')
const demosDir = join(here, '../../src/demos/guidance')

const files = readdirSync(contentDir)
  .filter((name) => name.endsWith('.mdx'))
  .map((name) => ({ name, source: readFileSync(join(contentDir, name), 'utf8') }))

/** The Markdown of a page without its fenced code, for rules about prose. */
function prose(source: string): string {
  return source.replace(/```[\s\S]*?```/g, '')
}

/** The slugs of the guidance pages, in the order of their `meta.order`. */
const EXPECTED = [
  'layout',
  'forms',
  'tables-and-grids',
  'modality',
  'confirmation-ladder',
  'plan-and-apply',
  'truthful-states',
  'production-cues',
  'untrusted-content',
  'charts',
  'copywriting',
  'keyboard-shortcuts',
  'error-handling',
  'query-conventions',
  'composition-patterns',
  'accessibility',
] as const

describe('the guidance pages', () => {
  it('cover every topic of the order, in a fixed order', () => {
    const pages = PAGES.filter((page) => page.area === 'guidance')
    expect(pages.map((page) => page.slug)).toEqual([...EXPECTED])
    const orders = pages.map((page) => page.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('declare a title that matches the h1 and a one-sentence description', () => {
    for (const file of files) {
      const meta = readMeta(file.source, file.name)
      expect(file.source, file.name).toContain(`\n# ${meta.title}\n`)
      expect(meta.description.endsWith('.'), file.name).toBe(true)
      expect(meta.description.trim().split(/\.\s/).length, file.name).toBe(1)
    }
  })

  it('use only demos that exist, and every demo of the guidance is used by a page', () => {
    const used = new Set<string>()
    for (const file of files) {
      for (const match of file.source.matchAll(/<Demo\s+id="([^"]+)"\s*\/>/g)) {
        const id = match[1] ?? ''
        expect(DEMOS.has(id), `${file.name}: ${id}`).toBe(true)
        used.add(id)
      }
    }
    const own = [...DEMOS.keys()].filter((id) => id.startsWith('guidance/'))
    expect(own.filter((id) => !used.has(id))).toEqual([])
  })

  it('name every demo after its page: guidance/<page>/<state>', () => {
    const slugs = new Set<string>(EXPECTED)
    for (const id of DEMOS.keys()) {
      if (!id.startsWith('guidance/')) continue
      const [, page] = id.split('/')
      expect(slugs.has(page ?? ''), id).toBe(true)
    }
  })
})

describe('the words of the guidance', () => {
  it('never name the assistant, the console or the wrong spelling of PostgreSQL', () => {
    for (const file of files) {
      // The vocabulary list may name a forbidden word in quotes, to forbid it.
      const text = prose(file.source).replace(/"(?:console|Postgres|run|branch)"/g, '')
      expect(text, file.name).not.toMatch(ASSISTANT_NAME)
      expect(text, file.name).not.toMatch(/\bconsole\b/i)
      expect(text, file.name).not.toMatch(/\bpostgres\b(?!ql)/i)
    }
  })

  it('use no exclamation marks in prose', () => {
    for (const file of files) {
      expect(prose(file.source).replace(/`[^`\n]*`/g, ''), file.name).not.toMatch(/!/)
    }
  })

  it('contain no raw invisible, control or direction character', () => {
    const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
    const sources = [
      ...files,
      ...readdirSync(demosDir).map((name) => ({
        name,
        source: readFileSync(join(demosDir, name), 'utf8'),
      })),
    ]
    for (const file of sources) {
      const offending = [...file.source].filter((ch) => hidden.test(ch) && ch !== '\n')
      expect(offending, file.name).toEqual([])
    }
  })

  it('keep the Markdown export intact: no line starts with import or export outside the meta', () => {
    for (const file of files) {
      const markdown = toMarkdown(file.source)
      expect(markdown, file.name).not.toMatch(/^(import|export)\s/m)
      // Fenced code survives the export untouched.
      const fences = (file.source.match(/```/g) ?? []).length
      expect((markdown.match(/```/g) ?? []).length, file.name).toBe(fences)
    }
  })

  it('write every pipe table with a header separator, so the GFM build renders it as a table', () => {
    for (const file of files) {
      const lines = prose(file.source).split('\n')
      lines.forEach((line, index) => {
        const starts = /^\|.*\|\s*$/.test(line) && !/^\|.*\|\s*$/.test(lines[index - 1] ?? '')
        if (starts)
          expect(lines[index + 1] ?? '', `${file.name}:${index + 1}`).toMatch(/^\|[\s:|-]+\|\s*$/)
      })
    }
  })

  it('link only to pages that exist', () => {
    const slugs = new Set<string>(EXPECTED)
    for (const file of files) {
      for (const match of file.source.matchAll(/\]\((\/[^)\s]*)\)/g)) {
        const target = match[1] ?? ''
        expect(target.startsWith('/guidance/'), `${file.name}: ${target}`).toBe(true)
        expect(slugs.has(target.slice('/guidance/'.length)), `${file.name}: ${target}`).toBe(true)
      }
    }
  })

  it('restate the audit reason warning in the words the Web App uses', () => {
    const copy = files.find((file) => file.name === 'copywriting.mdx')?.source ?? ''
    expect(copy).toContain(
      'This reason is kept permanently in the audit log. Do not enter personal data.',
    )
  })
})
