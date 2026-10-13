import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { DEMOS } from '../../src/demos/registry.ts'
import { RoutingProvider } from '../../src/router.tsx'
import { guidanceDemoIds, renderDemo } from './support.tsx'

afterEach(cleanup)

const IDS = guidanceDemoIds()

/** Generated ids differ from one render to the next; the markup should not. */
function stable(html: string): string {
  return html.replace(/_r_[0-9a-z]+_/g, '_r_').replace(/recharts\d+/g, 'recharts')
}

describe('every demo of the guidance', () => {
  it('has a title, an id of the form guidance/<page>/<state> and a render function', () => {
    expect(IDS.length).toBeGreaterThan(40)
    for (const id of IDS) {
      const demo = DEMOS.get(id)
      expect(id).toMatch(/^guidance\/[a-z-]+\/[a-z0-9-]+$/)
      expect(demo?.title.trim().length ?? 0, id).toBeGreaterThan(10)
      expect(typeof demo?.render, id).toBe('function')
    }
  })

  it.each(IDS)(
    '%s renders without an h1, a title attribute, a remote resource or a violation',
    async (id) => {
      const { container } = renderDemo(id)
      await waitFor(() => expect(container.firstChild).not.toBeNull())
      // The page owns the h1; a title attribute is not an accessible description.
      expect(container.querySelector('h1'), id).toBeNull()
      expect(container.querySelector('[title]'), id).toBeNull()
      expect(
        container.querySelector('img, iframe, script, link, [src], a[href^="http"]'),
        id,
      ).toBeNull()
      expect(await axeViolations(container), id).toEqual([])
    },
    30_000,
  )

  it.each(IDS)(
    '%s renders the same markup every time',
    (id) => {
      const first = renderDemo(id)
      const before = stable(first.container.innerHTML)
      first.unmount()
      const second = renderDemo(id)
      expect(stable(second.container.innerHTML), id).toBe(before)
    },
    30_000,
  )

  it('shows no raw hidden or direction character anywhere it renders text', () => {
    const hidden = /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/u
    for (const id of IDS) {
      const { container, unmount } = renderDemo(id)
      expect(hidden.test(container.textContent ?? ''), id).toBe(false)
      unmount()
    }
  })

  it('renders in the light and the dark frame of the visual host at once without a violation', async () => {
    const visual = IDS.filter((id) => DEMOS.get(id)?.visual !== false)
    expect(visual.length).toBeGreaterThan(30)
    const { container } = render(
      <RoutingProvider>
        <TooltipProvider>
          {visual.map((id) => (
            <section key={id} aria-label={DEMOS.get(id)?.title ?? id}>
              {(['light', 'dark'] as const).map((theme) => (
                <div key={theme} data-theme={theme} data-visual={`${id}:${theme}`}>
                  {DEMOS.get(id)?.render()}
                </div>
              ))}
            </section>
          ))}
        </TooltipProvider>
      </RoutingProvider>,
    )
    for (const id of visual) {
      expect(container.querySelector(`[data-visual="${id}:light"]`), id).not.toBeNull()
      expect(container.querySelector(`[data-visual="${id}:dark"]`), id).not.toBeNull()
    }
    expect(await axeViolations(container)).toEqual([])
  }, 120_000)
})
