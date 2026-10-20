import '@testing-library/jest-dom/vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ui from '@exponetdb/ui'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { PAGES } from '../../src/content/registry.ts'
import { DEMOS } from '../../src/demos/registry.ts'

/**
 * Checks on the `tokens` and `ui` pages and demos of the design system (Phase 6, group D2):
 * the shape every component page has, that every export of `@exponetdb/ui` is documented,
 * that every demo is used once and renders without a console error or an accessibility
 * violation in both themes.
 */
const root = join(import.meta.dirname, '..', '..', 'src')

interface Source {
  readonly area: 'tokens' | 'ui'
  readonly slug: string
  readonly file: string
  readonly text: string
}

function sources(area: 'tokens' | 'ui'): readonly Source[] {
  const dir = join(root, 'content', area)
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mdx'))
    .sort()
    .map((name) => ({
      area,
      slug: name.replace(/\.mdx$/, ''),
      file: `${area}/${name}`,
      text: readFileSync(join(dir, name), 'utf8'),
    }))
}

const UI_PAGES = sources('ui')
/** Pages about helpers, not a component: they need a purpose and demos, not the component sections. */
const HELPER_PAGES: ReadonlySet<string> = new Set(['utilities'])
const TOKEN_PAGES = sources('tokens')
const ALL_PAGES = [...TOKEN_PAGES, ...UI_PAGES]

const headings = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim())

const demoIds = (text: string): string[] =>
  [...text.matchAll(/<Demo\s+id="([a-z0-9/.-]+)"\s*\/>/g)].map((match) => match[1] ?? '')

describe('the shape of every component page', () => {
  it('has pages for the tokens and the components', () => {
    expect(TOKEN_PAGES.length).toBeGreaterThanOrEqual(5)
    expect(UI_PAGES.length).toBeGreaterThanOrEqual(25)
  })

  it.each(
    UI_PAGES.filter((page) => !HELPER_PAGES.has(page.slug)).map(
      (page) => [page.file, page] as const,
    ),
  )(
    '%s has purpose, when to use, anatomy, states, accessibility and copy, in order',
    (_file, page) => {
      const sections = headings(page.text)
      const required = ['When to use', 'Anatomy', 'States', 'Accessibility', 'Copy']
      const positions = required.map((name) => sections.indexOf(name))
      expect(positions, `${page.file}: headings are ${sections.join(' / ')}`).not.toContain(-1)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
      // The purpose comes first: a paragraph right after the title, before the first section.
      const afterTitle = page.text.split(/^# .+$/m)[1] ?? ''
      const intro = afterTitle.split(/^## /m)[0] ?? ''
      expect(
        intro.replace(/<Demo[^>]*>/g, '').trim().length,
        `${page.file}: purpose`,
      ).toBeGreaterThan(80)
    },
  )

  it.each(ALL_PAGES.map((page) => [page.file, page] as const))(
    '%s has live demos that exist and belong to the page',
    (_file, page) => {
      const ids = demoIds(page.text)
      expect(ids.length, `${page.file}: at least one demo`).toBeGreaterThan(0)
      for (const id of ids) {
        expect(DEMOS.has(id), `${page.file}: unknown demo ${id}`).toBe(true)
        expect(id.startsWith(`${page.area}/${page.slug}/`), `${page.file}: ${id}`).toBe(true)
      }
      expect(new Set(ids).size, `${page.file}: a demo is shown once`).toBe(ids.length)
    },
  )

  it('shows every demo of the tokens and ui areas on a page', () => {
    const used = new Set(ALL_PAGES.flatMap((page) => demoIds(page.text)))
    const orphans = [...DEMOS.keys()].filter(
      (id) => (id.startsWith('ui/') || id.startsWith('tokens/')) && !used.has(id),
    )
    expect(orphans).toEqual([])
  })
})

describe('what the pages say', () => {
  it('names every export of @exponetdb/ui on a component page', () => {
    const text = UI_PAGES.map((page) => page.text).join('\n')
    const missing = Object.keys(ui).filter((name) => !new RegExp(`\\b${name}\\b`).test(text))
    expect(missing).toEqual([])
  })

  it('links only to pages that exist, and never to a heading that has no id', () => {
    const known = new Set(PAGES.map((page) => page.path))
    const links = ALL_PAGES.flatMap((page) =>
      [...page.text.matchAll(/\]\((\/[^)\s]*)\)/g)].map((match) => ({
        file: page.file,
        link: match[1] ?? '',
      })),
    )
    expect(links.length).toBeGreaterThan(20)
    expect(
      links.filter(({ link }) => !known.has(link)).map(({ file, link }) => `${file}: ${link}`),
    ).toEqual([])
  })

  it.each(ALL_PAGES.map((page) => [page.file, page] as const))(
    '%s has a meta block the index can read, one h1 and no unsafe text',
    (_file, page) => {
      const lines = page.text.split('\n')
      expect(lines[0]).toBe('export const meta = {')
      expect(page.text.match(/^# /gm)?.length).toBe(1)
      // The Markdown export drops every line that starts with import or export.
      const statements = lines.filter((line) => /^(import|export)\s/.test(line))
      expect(statements).toEqual(['export const meta = {'])
      // No invisible or direction character, no remote URL, no title attribute, no vendor word.
      expect(page.text).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/u)
      expect(page.text).not.toMatch(/https?:\/\//)
      expect(page.text).not.toMatch(/\btitle=/)
      expect(page.text).not.toMatch(/\bconsole\b|\bREOSA\b|\bSupabase\b/i)
      // The product speaks of targets and plans, and of PostgreSQL.
      expect(page.text).not.toMatch(/\bPostgres\b/)
    },
  )
})

const HIDDEN = /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/u

/**
 * Generated ids differ from one render to the next; the markup should not. A menu skeleton
 * derives a width from its id (the sidebar demo overrides it with a class), so that is masked too.
 */
const stable = (html: string): string =>
  html
    .replace(/_r_[0-9a-z]+_/g, '_r_')
    .replace(/recharts\d+/g, 'recharts')
    .replace(/--skeleton-width: \d+%/g, '--skeleton-width: N%')

describe('the demos of the tokens and ui areas', () => {
  const mine = [...DEMOS.values()].filter(
    (demo) => demo.id.startsWith('ui/') || demo.id.startsWith('tokens/'),
  )

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('has demos', () => {
    expect(mine.length).toBeGreaterThan(20)
  })

  it.each(mine.map((demo) => [demo.id, demo] as const))(
    '%s renders in light and dark without a console message or a violation',
    async (id, demo) => {
      if (id.startsWith('ui/chart/')) {
        // jsdom has no layout: give the responsive container the size a browser would measure.
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
          new DOMRect(0, 0, 360, 220),
        )
      }
      for (const theme of ['light', 'dark'] as const) {
        const view = render(
          <TooltipProvider>
            <div data-theme={theme} className="bg-background p-6 text-foreground">
              {demo.render()}
            </div>
          </TooltipProvider>,
        )
        expect(await axeViolations(view.container), `${demo.id} (${theme})`).toEqual([])
        // The page owns the h1; a title attribute is not an accessible description; nothing is remote.
        expect(view.container.querySelector('h1'), demo.id).toBeNull()
        expect(view.container.querySelector('[title]'), demo.id).toBeNull()
        expect(
          view.container.querySelector('img, iframe, script, link, [src], a[href^="http"]'),
          demo.id,
        ).toBeNull()
        // Text that came from outside is shown by code point: no raw hidden or direction character.
        expect(HIDDEN.test(view.container.textContent ?? ''), demo.id).toBe(false)
        view.unmount()
      }
      expect(console.error).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
    },
    30_000,
  )

  it.each(mine.map((demo) => [demo.id, demo] as const))(
    '%s renders the same markup every time',
    (id, demo) => {
      if (id.startsWith('ui/chart/')) {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
          new DOMRect(0, 0, 360, 220),
        )
      }
      const first = render(<TooltipProvider>{demo.render()}</TooltipProvider>)
      const before = stable(first.container.innerHTML)
      first.unmount()
      const second = render(<TooltipProvider>{demo.render()}</TooltipProvider>)
      expect(stable(second.container.innerHTML), id).toBe(before)
    },
    30_000,
  )
})
