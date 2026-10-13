import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGES } from '../../src/content/registry.ts'
import { DEMOS } from '../../src/demos/registry.ts'

// The MDX sources as text: the build compiles them, so the tests read the files themselves.
// Vitest runs from the app's directory, as the commands of the app do.
const contentDir = join(process.cwd(), 'src', 'content')
const entries = ['ui-patterns', 'ui-data'].flatMap((area) =>
  readdirSync(join(contentDir, area))
    .filter((name) => name.endsWith('.mdx'))
    .map((name) => ({
      file: `${area}/${name}`,
      source: readFileSync(join(contentDir, area, name), 'utf8'),
    })),
)

/** Demo ids a page shows. */
function demoIds(source: string): string[] {
  return [...source.matchAll(/<Demo id="([a-z0-9/.-]+)"\s*\/>/g)].map((m) => m[1] ?? '')
}

describe('the pages of the patterns and the data components', () => {
  it('has about twenty pattern pages and a page for each data component', () => {
    const patterns = entries.filter((entry) => entry.file.startsWith('ui-patterns/'))
    const data = entries.filter((entry) => entry.file.startsWith('ui-data/'))
    expect(patterns.length).toBeGreaterThanOrEqual(15)
    expect(patterns.length).toBeLessThanOrEqual(24)
    expect(data.length).toBeGreaterThanOrEqual(10)
  })

  it.each(entries.map((entry) => [entry.file, entry.source] as const))(
    '%s has live demos, accessibility notes and copy rules',
    (_file, source) => {
      expect(demoIds(source).length).toBeGreaterThan(0)
      expect(source).toMatch(/^## Accessibility$/m)
      expect(source).toMatch(/^## Copy$/m)
    },
  )

  it.each(entries.map((entry) => [entry.file, entry.source] as const))(
    '%s shows only demos that exist and none twice',
    (_file, source) => {
      const ids = demoIds(source)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(DEMOS.has(id), id).toBe(true)
    },
  )

  it('shows every demo of the two areas on a page, so no demo is orphaned', () => {
    const shown = new Set(entries.flatMap((entry) => demoIds(entry.source)))
    const orphans = [...DEMOS.keys()].filter(
      (id) => (id.startsWith('ui-patterns/') || id.startsWith('ui-data/')) && !shown.has(id),
    )
    // The demos of the guidance pages use their own ids; these two areas belong to these pages.
    expect(orphans).toEqual([])
  })

  it('lists each page in the registry under its area', () => {
    for (const entry of entries) {
      const [area, name] = entry.file.replace('.mdx', '').split('/')
      expect(
        PAGES.some((page) => page.path === `/${area}/${name}`),
        entry.file,
      ).toBe(true)
    }
  })

  it.each(entries.map((entry) => [entry.file, entry.source] as const))(
    '%s keeps to the vocabulary and the voice',
    (_file, source) => {
      // PostgreSQL, never "Postgres"; the Web App is not a "console".
      expect(source).not.toMatch(/\bPostgres\b(?!QL)/)
      expect(source).not.toMatch(/\bconsole\b/i)
      // No exclamation marks in prose; code spans may hold `!=` and `!==`.
      const prose = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
      expect(prose).not.toMatch(/!(?!\[)/)
      // No hidden, direction or tag character is ever written into a file.
      expect(source).not.toMatch(/[​-‏‪-‮⁠-⁩﻿]/)
      expect(source).not.toMatch(/[\u{E0000}-\u{E007F}]/u)
      // No dash used as a sentence mark in the UI copy examples would be checked by review; none of these files links out.
      expect(source).not.toMatch(/https?:\/\//)
    },
  )

  it('opens each page with a meta block of the form the index reads and a single h1', () => {
    for (const entry of entries) {
      expect(entry.source.startsWith('export const meta = {\n  title: "'), entry.file).toBe(true)
      expect((entry.source.match(/^# /gm) ?? []).length, entry.file).toBe(1)
    }
  })
})
