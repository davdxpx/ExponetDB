import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  installAdoptedSheets,
  installLayoutStubs,
} from '../../../../packages/ui-data/test/editor/support.ts'
import { mockChartLayout } from '../../../../packages/ui-patterns/test/charts/layout.ts'
import { DEMOS } from '../../src/demos/registry.ts'
import { HOSTILE, patternDemoIds, renderDemo } from './support.tsx'

afterEach(cleanup)
// jsdom has no layout: charts and editors get the stand-ins that the tests of their packages use.
mockChartLayout()
beforeAll(() => {
  installLayoutStubs()
  installAdoptedSheets()
})

const IDS = patternDemoIds()

describe('the demos of the patterns and the data components', () => {
  it('has demos for both areas', () => {
    expect(IDS.some((id) => id.startsWith('ui-patterns/'))).toBe(true)
    expect(IDS.some((id) => id.startsWith('ui-data/'))).toBe(true)
  })

  it('titles every demo and keeps ids to the <area>/<component>/<state> shape', () => {
    for (const id of IDS) {
      const demo = DEMOS.get(id)
      expect(demo?.title, id).toBeTruthy()
      expect(id.split('/').length, id).toBe(3)
    }
  })

  it.each(IDS)(
    'renders %s in light and dark without an accessibility violation',
    async (id) => {
      for (const theme of ['light', 'dark'] as const) {
        const view = renderDemo(id, theme)
        expect(await axeViolations(view.container), `${id} (${theme})`).toEqual([])
        view.unmount()
      }
    },
    30_000,
  )

  it.each(IDS)('loads nothing from outside and sets no title attribute: %s', (id) => {
    const view = renderDemo(id)
    expect(view.container.querySelectorAll('[title]'), `${id} has a title attribute`).toHaveLength(
      0,
    )
    expect(
      view.container.querySelectorAll('img, iframe, script, link, video, audio, object, embed'),
    ).toHaveLength(0)
    for (const element of view.container.querySelectorAll('[src], [href]')) {
      const address = element.getAttribute('src') ?? element.getAttribute('href') ?? ''
      // Only paths of the app and fragments: never an address with a host.
      expect(address, `${id}: ${address}`).toMatch(/^(\/(?!\/)|#|$)/)
    }
  })

  it.each(IDS)('puts no hidden or direction character into the document: %s', (id) => {
    const view = renderDemo(id)
    const text = view.container.textContent ?? ''
    for (const [name, character] of Object.entries(HOSTILE)) {
      expect(text.includes(character), `${id} holds ${name}`).toBe(false)
    }
  })
})
