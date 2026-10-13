import { Button, cn } from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import { DEMOS } from '../demos/registry.ts'

/**
 * A live demo on a page: the demo in a bordered frame with its own theme
 * switch (the tokens derive on every `[data-theme]`, so a frame can be dark
 * on a light page). An unknown id is an error a page author sees at once.
 */
export function Demo({ id }: { readonly id: string }): ReactNode {
  const demo = DEMOS.get(id)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const titleId = useId()
  if (demo === undefined) {
    throw new Error(`unknown demo "${id}"`)
  }
  return (
    <figure
      aria-labelledby={titleId}
      className="my-6 overflow-hidden rounded-lg border border-default"
    >
      <figcaption className="flex items-center justify-between gap-2 border-b border-default bg-surface-75 px-4 py-2">
        <span id={titleId} className="text-sm font-medium text-foreground">
          {demo.title}
        </span>
        <Button
          type="button"
          variant="text"
          size="tiny"
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        >
          Dark theme
        </Button>
      </figcaption>
      <div
        data-theme={theme}
        data-demo={demo.id}
        className={cn('bg-background p-6 text-foreground')}
      >
        {demo.render()}
      </div>
    </figure>
  )
}
