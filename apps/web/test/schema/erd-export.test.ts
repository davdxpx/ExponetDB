import type { SchemaErdData } from '@exponetdb/ui-data'
import { describe, expect, it } from 'vitest'
import {
  diagramMarkdown,
  diagramSvg,
  exportFileName,
  visibleText,
  xmlText,
} from '../../src/features/schema/erd-export.ts'

const BIDI = String.fromCodePoint(0x202e)
const ZWSP = String.fromCodePoint(0x200b)
const META = {
  target: 'shop/platform/staging',
  observedAt: '2026-10-20T10:00:00.000Z',
  source: 'live',
  undrawn: 0,
  tablesRead: 2,
}

const DATA: SchemaErdData = {
  tables: [
    {
      id: 'users',
      schema: 'public',
      name: 'users',
      columns: [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'email', type: 'text' },
      ],
    },
    {
      id: 'orders',
      schema: 'public',
      name: 'orders',
      columns: [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'user_id', type: 'uuid' },
      ],
    },
  ],
  relations: [
    {
      name: 'orders_user_fk',
      fromTable: 'orders',
      fromColumns: ['user_id'],
      toTable: 'users',
      toColumns: ['id'],
    },
  ],
}

const HOSTILE: SchemaErdData = {
  tables: [
    {
      id: 'a',
      schema: `s${BIDI}x`,
      name: '</text><script>alert(1)</script>&"\'',
      columns: [
        { name: `c${ZWSP}ol`, type: 'text', pk: true },
        { name: 'bad\u0000\u0001￾', type: 'text' },
        { name: '\ud800lone', type: 'text' },
        { name: 'a|b', type: 'text' },
      ],
    },
    { id: 'b', schema: 'public', name: 'b`ack`tick|pipe', columns: [] },
  ],
  relations: [
    {
      name: '</desc><foreignObject>',
      fromTable: 'a',
      fromColumns: [`c${ZWSP}ol`],
      toTable: 'b',
      toColumns: ['x'],
    },
  ],
}

/** Whether the text holds a character XML 1.0 does not allow (a control character other than tab and line breaks, a noncharacter, a lone surrogate). */
function hasInvalidXmlCharacter(text: string): boolean {
  for (const character of text) {
    const cp = character.codePointAt(0) ?? 0
    if (
      (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) ||
      cp === 0xfffe ||
      cp === 0xffff ||
      (cp >= 0xd800 && cp <= 0xdfff)
    ) {
      return true
    }
  }
  return false
}

function parsed(svg: string): Document {
  return new DOMParser().parseFromString(svg, 'image/svg+xml')
}

describe('the SVG export', () => {
  it('is well-formed XML with a title, a description and one box per table', () => {
    const svg = diagramSvg(DATA, META)
    const doc = parsed(svg)
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(doc.documentElement.tagName).toBe('svg')
    expect(doc.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg')
    expect(doc.getElementsByTagName('title')[0]?.textContent).toContain('shop/platform/staging')
    expect(doc.getElementsByTagName('desc')[0]?.textContent).toContain('2 tables, 1 relation')
    expect(doc.getElementsByTagName('g')).toHaveLength(2)
    expect(doc.getElementsByTagName('line')).toHaveLength(1)
    const text = doc.documentElement.textContent ?? ''
    expect(text).toContain('public.users')
    expect(text).toContain('PK id')
    // The relations are listed as text under the drawing.
    expect(text).toContain('orders_user_fk: public.orders (user_id) -> public.users (id)')
  })

  it('says when it was read, from where, and what it leaves out', () => {
    const svg = diagramSvg(DATA, { ...META, undrawn: 3 })
    expect(svg).toContain('Read 2026-10-20T10:00:00.000Z (live)')
    expect(svg).toContain('3 foreign keys were not drawn')
  })

  it('draws nothing that reaches out: no foreignObject, script, style, link, image or remote font', () => {
    for (const data of [DATA, HOSTILE]) {
      const svg = diagramSvg(data, META)
      // Markup in a name is escaped text, so only a real element can match a `<tag`.
      expect(svg).not.toMatch(
        /<(foreignObject|script|style|image|a|use|link)[\s>/]|@import|url\(\s*['"]?https?:/i,
      )
      expect(svg.replaceAll('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//)
      expect(svg).toContain(
        'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"',
      )
    }
  })

  it('shows hostile names as text with hidden characters as code points, and stays well-formed', () => {
    const svg = diagramSvg(HOSTILE, META)
    const doc = parsed(svg)
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(doc.getElementsByTagName('script')).toHaveLength(0)
    expect(doc.getElementsByTagName('foreignObject')).toHaveLength(0)
    expect(svg).not.toContain(BIDI)
    expect(svg).not.toContain(ZWSP)
    expect(hasInvalidXmlCharacter(svg)).toBe(false)
    const text = doc.documentElement.textContent ?? ''
    expect(text).toContain('⟨U+202E⟩')
    expect(text).toContain('⟨U+200B⟩')
    expect(text).toContain('⟨U+0000⟩')
    expect(text).toContain('⟨U+FFFE⟩')
    expect(text).toContain('⟨U+D800⟩')
    // The markup in a name is text, not elements.
    expect(text).toContain('</text><script>alert(1)</script>&"\'')
  })

  it('is the same bytes for the same read', () => {
    expect(diagramSvg(DATA, META)).toBe(diagramSvg(DATA, META))
  })

  it('says when it holds only some of the tables read', () => {
    const svg = diagramSvg(DATA, { ...META, tablesRead: 5 })
    expect(svg).toContain('Only 2 of the 5 tables read are included.')
    expect(diagramSvg(DATA, META)).not.toContain('tables read are included')
  })

  it('draws an empty read as an empty drawing, with the title', () => {
    const doc = parsed(diagramSvg({ tables: [], relations: [] }, META))
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(doc.getElementsByTagName('g')).toHaveLength(0)
  })

  it('counts the columns and the relations it does not list', () => {
    const wide: SchemaErdData = {
      tables: [
        {
          id: 'w',
          schema: 'public',
          name: 'wide',
          columns: Array.from({ length: 30 }, (_, n) => ({ name: `c${n}`, type: 'integer' })),
        },
      ],
      relations: Array.from({ length: 205 }, (_, n) => ({
        name: `r${n}`,
        fromTable: 'w',
        fromColumns: ['c0'],
        toTable: 'w',
        toColumns: ['c1'],
      })),
    }
    const text = parsed(diagramSvg(wide, META)).documentElement.textContent ?? ''
    expect(text).toContain('and 6 more columns')
    expect(text).toContain('and 5 more relations')
  })
})

describe('the Markdown export', () => {
  it('lists each table with its columns and keys, then the relations', () => {
    const md = diagramMarkdown(DATA, META)
    expect(md).toContain('# Schema of `shop/platform/staging`')
    expect(md).toContain('2 tables, 1 relation. Read 2026-10-20T10:00:00.000Z (live).')
    expect(md).toContain('## `public.orders`')
    expect(md).toContain('| `id` | `uuid` | PK |')
    expect(md).toContain('| `user_id` | `uuid` | FK |')
    expect(md).toContain('- `orders_user_fk`: `public.orders` (`user_id`) -> `public.users` (`id`)')
  })

  it('says when it holds only some of the tables read', () => {
    expect(diagramMarkdown(DATA, { ...META, tablesRead: 7 })).toContain(
      'Only 2 of the 7 tables read are included.',
    )
  })

  it('says what it leaves out', () => {
    expect(diagramMarkdown(DATA, { ...META, undrawn: 2 })).toContain(
      '2 foreign keys were not included.',
    )
  })

  it('shows hostile names inside code spans, with hidden characters as code points', () => {
    const md = diagramMarkdown(HOSTILE, META)
    expect(md).not.toContain(BIDI)
    expect(md).not.toContain(ZWSP)
    expect(md).toContain('⟨U+202E⟩')
    // A backtick or a pipe in a name cannot end the span or the table cell.
    expect(md).toContain('## ``public.b`ack`tick|pipe``')
    expect(md).toContain('| `a\\|b` | `text` |')
    for (const line of md.split('\n')) {
      if (line.startsWith('|') && !line.startsWith('| ---') && !line.startsWith('| Column')) {
        expect(line.replaceAll('\\|', '').split('|').length).toBe(5)
      }
    }
  })
})

describe('helpers', () => {
  it('cuts at the bound and marks the cut', () => {
    expect(visibleText('abcdef', 3)).toBe('abc…')
    expect(visibleText('abc', 3)).toBe('abc')
  })

  it('escapes markup after the hidden characters are shown', () => {
    expect(xmlText(`<a href="x">&'${BIDI}`, 100)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&apos;⟨U+202E⟩',
    )
  })

  it('names the file from the validated target path only', () => {
    expect(exportFileName('shop/platform/staging', 'svg')).toBe('schema-shop-platform-staging.svg')
    expect(exportFileName('shop/platform/staging', 'md')).toBe('schema-shop-platform-staging.md')
  })
})
