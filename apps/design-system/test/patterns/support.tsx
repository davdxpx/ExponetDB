import { TooltipProvider } from '@exponetdb/ui'
import { render } from '@testing-library/react'
import { DEMOS } from '../../src/demos/registry.ts'

/** The demo with this id, rendered the way the app renders it: inside the tooltip provider. */
export function renderDemo(
  id: string,
  theme: 'light' | 'dark' = 'light',
): ReturnType<typeof render> {
  const demo = DEMOS.get(id)
  if (demo === undefined) throw new Error(`unknown demo "${id}"`)
  return render(
    <TooltipProvider delayDuration={0}>
      <div data-theme={theme} data-demo={id}>
        {demo.render()}
      </div>
    </TooltipProvider>,
  )
}

/** Ids of the demos of the two areas this group owns. */
export function patternDemoIds(): readonly string[] {
  return [...DEMOS.keys()].filter(
    (id) => id.startsWith('ui-patterns/') || id.startsWith('ui-data/'),
  )
}

/**
 * Characters that change what a reader sees without being seen: the demos use them as hostile values, and no
 * view of untrusted text may hand one on to the document. Written as braced escapes, never as raw characters.
 */
export const HOSTILE = {
  rlo: '\u{202E}',
  zwsp: '\u{200B}',
  lri: '\u{2066}',
} as const
