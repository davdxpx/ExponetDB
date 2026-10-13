import { Button, Progress, Skeleton } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

function Loading(): ReactNode {
  return (
    <div className="flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-foreground-light">
          animate-pulse motion-reduce:animate-none
        </p>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-foreground-light">The spinner of a loading button</p>
        <div>
          <Button variant="primary" loading>
            Applying plan
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-foreground-light">An indeterminate progress bar</p>
        <Progress aria-label="Verifying the migration" />
      </div>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'tokens/motion/loading',
    title: 'Loading motion stops for people who ask for reduced motion',
    render: () => <Loading />,
  },
]
