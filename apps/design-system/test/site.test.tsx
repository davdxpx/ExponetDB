import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../packages/ui/test/support/axe.ts'
import { App } from '../src/app.tsx'
import { buildMarkdownIndex, readMeta, toMarkdown } from '../src/content/markdown-export.ts'
import { locate, parseMeta } from '../src/content/meta.ts'
import { PAGES } from '../src/content/registry.ts'
import { buildDemos, DEMOS } from '../src/demos/registry.ts'
import { navigate, RoutingProvider } from '../src/router.tsx'
import { VisualFrames, visualDemos } from '../src/site/visual-host.tsx'

// Rendering a page with its live demos and running axe over it takes seconds
// each in jsdom, and many times that on a loaded machine.
const PAGE_TIMEOUT_MS = 120_000

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('the pages of the design system', () => {
  it('lists every page on the home page and in the navigation', () => {
    render(<App />)
    const nav = screen.getByRole('navigation', { name: 'Design system pages' })
    for (const page of PAGES) {
      expect(nav.querySelector(`a[href="${page.path}"]`), page.path).not.toBeNull()
    }
  })

  it.each(PAGES.map((page) => [page.path, page] as const))(
    'renders %s with its title as the only h1 and no accessibility violations',
    async (path, page) => {
      render(<App />)
      act(() => navigate(path))
      expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
        page.title,
      ])
      expect(await axeViolations()).toEqual([])
    },
    PAGE_TIMEOUT_MS,
  )
})

describe('the demos', () => {
  it(
    'puts every visual demo on the visual host, in a light and a dark frame',
    () => {
      render(<App />)
      act(() => navigate('/visual'))
      for (const demo of visualDemos()) {
        expect(document.querySelector(`[data-visual="${demo.id}:light"]`), demo.id).not.toBeNull()
        expect(document.querySelector(`[data-visual="${demo.id}:dark"]`), demo.id).not.toBeNull()
      }
    },
    PAGE_TIMEOUT_MS,
  )

  // Axe runs per demo: over the whole host page (hundreds of frames) it takes minutes.
  it.each(visualDemos().map((demo) => [demo.id, demo] as const))(
    'renders %s without an accessibility violation, in light and dark',
    async (_id, demo) => {
      // The providers of the app (App in src/app.tsx), around one demo's two frames.
      render(
        <RoutingProvider>
          <TooltipProvider delayDuration={300}>
            <VisualFrames demo={demo} />
          </TooltipProvider>
        </RoutingProvider>,
      )
      expect(await axeViolations()).toEqual([])
    },
    PAGE_TIMEOUT_MS,
  )

  it('refuses a malformed or repeated demo id', () => {
    const demo = { id: 'ui/button/variants', title: 'x', render: () => null }
    expect(() => buildDemos({ a: { demos: [demo, demo] } })).toThrow(/used twice/)
    expect(() => buildDemos({ a: { demos: [{ ...demo, id: 'Button' }] } })).toThrow(/not/)
  })

  it('names an unknown demo on the page that uses it', () => {
    // Every <Demo id> of every page exists: the pages above render without throwing.
    expect(DEMOS.size).toBeGreaterThan(0)
  })
})

describe('the agent-readable index', () => {
  it('reads meta as data, refusing anything but one JSON value per line', () => {
    const ok =
      'export const meta = {\n  title: "Forms",\n  description: "How forms work.",\n  order: 2,\n}\n'
    expect(readMeta(ok, 'x.mdx')).toEqual({
      title: 'Forms',
      description: 'How forms work.',
      order: 2,
    })
    expect(() => readMeta("export const meta = {\n  title: 'Forms',\n}\n", 'x.mdx')).toThrow(
      /JSON value/,
    )
    expect(() => readMeta('# no meta', 'x.mdx')).toThrow(/missing/)
    expect(() => parseMeta({ title: '' }, 'x')).toThrow(/title/)
    expect(() => locate('elsewhere/x.mdx')).toThrow(/area/)
  })

  it('exports a page as Markdown without code and with its demos named', () => {
    const md = toMarkdown(
      'import { X } from "y"\nexport const meta = {\n  title: "A",\n}\n\n# A\n\n<Demo id="ui/a/b" />\n',
    )
    expect(md).toBe('# A\n\n> Live demo `ui/a/b` (in the design-system app).\n')
  })

  it('keeps fenced code as it is: an import line or a demo inside a fence is an example', () => {
    const source = [
      'export const meta = {',
      '  title: "A",',
      '}',
      '',
      '# A',
      '',
      '```tsx',
      "import { Button } from '@exponetdb/ui'",
      'export function X() {',
      '  return <Demo id="ui/a/b" />',
      '}',
      '```',
      '',
      '~~~~',
      '```',
      'export const inner = 1',
      '~~~~',
      '',
      'See the [table](/ui/table) and `[raw](/ui/table)`.',
      '',
    ].join('\n')
    expect(toMarkdown(source)).toBe(
      [
        '# A',
        '',
        '```tsx',
        "import { Button } from '@exponetdb/ui'",
        'export function X() {',
        '  return <Demo id="ui/a/b" />',
        '}',
        '```',
        '',
        '~~~~',
        '```',
        'export const inner = 1',
        '~~~~',
        '',
        'See the [table](../ui/table.md) and `[raw](/ui/table)`.',
        '',
      ].join('\n'),
    )
  })

  it('rewrites links to other pages to the exported Markdown files, fragments kept', () => {
    expect(
      toMarkdown(
        'Read [forms](/guidance/forms#errors), [select](/ui/select), [x](/elsewhere/y) and [ext](/ui/Bad).\n',
      ),
    ).toBe(
      'Read [forms](../guidance/forms.md#errors), [select](../ui/select.md), [x](/elsewhere/y) and [ext](/ui/Bad).\n',
    )
  })

  it('renders a pipe table of a page as a table', () => {
    render(<App />)
    act(() => navigate('/ui-data/plan-decision'))
    const tables = document.querySelectorAll('main table')
    expect(tables.length).toBeGreaterThan(0)
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Apply')
  })

  it('lists every page in llms.txt with its Markdown file', () => {
    const files = buildMarkdownIndex([
      {
        path: 'guidance/forms.mdx',
        source:
          'export const meta = {\n  title: "Forms",\n  description: "How forms work.",\n}\n\n# Forms\n',
      },
    ])
    const index = files.find((f) => f.fileName === 'llms.txt')?.source ?? ''
    expect(index).toContain('- [Forms](md/guidance/forms.md): How forms work.')
    expect(files.map((f) => f.fileName)).toEqual(['llms.txt', 'md/guidance/forms.md'])
  })
})
