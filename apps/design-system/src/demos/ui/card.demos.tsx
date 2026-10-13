import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@exponetdb/ui'
import { StateBadge, TierChip } from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'
import type { DemoDefinition } from '../types.ts'

const NOW = '2026-10-13T12:00:00.000Z'
const OBSERVED = '2026-10-13T11:56:00.000Z'

function Summary(): ReactNode {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Cluster pg-main</CardTitle>
        <CardDescription>PostgreSQL 17.2 on node reos-01</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-foreground-light">Health</dt>
          <dd>
            <StateBadge state="healthy" source="live" observedAt={OBSERVED} now={NOW} />
          </dd>
          <dt className="text-foreground-light">Placements</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">shop/platform/staging</span>
            <TierChip tier="nonprod" />
          </dd>
          <dt className="text-foreground-light">Last backup</dt>
          <dd>4 hours ago</dd>
        </dl>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="default">Open cluster</Button>
      </CardFooter>
    </Card>
  )
}

function Settings(): ReactNode {
  const id = useId()
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Approval window</CardTitle>
        <CardDescription>How long a plan waits for its approval.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} className="text-foreground-light">
            Hours (1 to 24)
          </Label>
          <Input id={id} type="number" inputMode="numeric" defaultValue={4} min={1} max={24} />
        </div>
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <p className="text-xs text-foreground-lighter">A longer wait is canceled.</p>
        <Button variant="primary">Save policy</Button>
      </CardFooter>
    </Card>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/card/summary',
    title: 'A summary card with facts and an action',
    render: () => <Summary />,
  },
  {
    id: 'ui/card/settings',
    title: 'A settings card with a field and a footer',
    render: () => <Settings />,
  },
]
