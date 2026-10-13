import { TooltipProvider } from '@exponetdb/ui'
import { type RenderResult, render } from '@testing-library/react'
import { DEMOS } from '../../src/demos/registry.ts'
import { RoutingProvider } from '../../src/router.tsx'

/** The ids of every demo of the guidance pages. */
export function guidanceDemoIds(): readonly string[] {
  return [...DEMOS.keys()].filter((id) => id.startsWith('guidance/'))
}

/** Renders one demo the way a page does: inside the link seam and the tooltip provider. */
export function renderDemo(id: string): RenderResult {
  const demo = DEMOS.get(id)
  if (demo === undefined) throw new Error(`unknown demo "${id}"`)
  return render(
    <RoutingProvider>
      <TooltipProvider delayDuration={0}>{demo.render()}</TooltipProvider>
    </RoutingProvider>,
  )
}
