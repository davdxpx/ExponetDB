import { Button, Progress, Skeleton } from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Loading(): ReactNode {
  return (
    <div className="max-w-md" aria-busy="true">
      <p role="status" className="sr-only">
        Loading targets
      </p>
      <ul className="flex flex-col gap-3" aria-hidden>
        {[0, 1, 2].map((row) => (
          <li key={row} className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
            <Skeleton className="h-6 w-16" />
          </li>
        ))}
      </ul>
    </div>
  )
}

function Determinate(): ReactNode {
  const [done, setDone] = useState(3)
  const total = 5
  return (
    <Stack className="max-w-md">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm text-foreground">Applying migrations</p>
        <p className="font-mono text-xs text-foreground-light">
          {done} of {total} steps
        </p>
      </div>
      <Progress aria-label="Applying migrations" value={done} max={total} />
      <Row>
        <Button
          variant="default"
          onClick={() => setDone((current) => Math.min(total, current + 1))}
        >
          Complete a step
        </Button>
        <Button variant="text" onClick={() => setDone(0)}>
          Start again
        </Button>
      </Row>
    </Stack>
  )
}

function Indeterminate(): ReactNode {
  return (
    <Stack className="max-w-md">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm text-foreground">Verifying the migration</p>
        <p className="text-xs text-foreground-light">Waiting for the target</p>
      </div>
      <Progress aria-label="Verifying the migration" />
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/skeleton-and-progress/skeleton',
    title: 'A skeleton shaped like the list it replaces, with the loading announced as text',
    render: () => <Loading />,
  },
  {
    id: 'ui/skeleton-and-progress/determinate',
    title: 'A determinate bar with the step count as text',
    render: () => <Determinate />,
  },
  {
    id: 'ui/skeleton-and-progress/indeterminate',
    title: 'An indeterminate bar when the amount is unknown',
    render: () => <Indeterminate />,
  },
]
