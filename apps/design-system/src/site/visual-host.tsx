import type { ReactNode } from 'react'
import { DEMOS } from '../demos/registry.ts'
import type { DemoDefinition } from '../demos/types.ts'

/** The demos the host shows: every demo that can be captured as a still image. */
export function visualDemos(): readonly DemoDefinition[] {
  return [...DEMOS.values()].filter((demo) => demo.visual !== false)
}

/** One demo's two frames, light and dark, each marked for the screenshot runner. */
export function VisualFrames({ demo }: { readonly demo: DemoDefinition }): ReactNode {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {(['light', 'dark'] as const).map((theme) => (
        <div
          key={theme}
          data-theme={theme}
          data-visual={`${demo.id}:${theme}`}
          className="rounded-lg border border-default bg-background p-6 text-foreground"
        >
          {demo.render()}
        </div>
      ))}
    </div>
  )
}

/**
 * The visual-regression host (order Phase 6): every demo that can be captured
 * as a still image, once in the light and once in the dark theme, each frame
 * marked `data-visual="<demo id>:<theme>"` for the screenshot runner of
 * Phase 15. Nothing here animates on its own; the runner turns animations
 * off with `prefers-reduced-motion`.
 */
export function VisualHost(): ReactNode {
  const demos = visualDemos()
  return (
    <main className="flex flex-col gap-8 bg-background p-6 text-foreground">
      <h1 className="text-xl font-semibold">Visual regression host</h1>
      {demos.length === 0 ? <p>No demos yet.</p> : null}
      {demos.map((demo) => (
        <section key={demo.id} aria-label={demo.title} className="flex flex-col gap-2">
          <h2 className="font-mono text-sm text-foreground-light">{demo.id}</h2>
          <VisualFrames demo={demo} />
        </section>
      ))}
    </main>
  )
}
