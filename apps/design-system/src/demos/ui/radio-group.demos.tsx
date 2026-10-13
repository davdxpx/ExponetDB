import { Database, Server } from '@exponetdb/icons'
import {
  Label,
  RadioGroup,
  RadioGroupCard,
  RadioGroupCardItem,
  RadioGroupItem,
  RadioGroupLargeItem,
  RadioGroupStacked,
  RadioGroupStackedItem,
} from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'

function Plain(): ReactNode {
  const groupId = useId()
  const targetId = useId()
  const clusterId = useId()
  const [scope, setScope] = useState('target')
  return (
    <div className="flex flex-col gap-2">
      <p id={groupId} className="text-sm font-medium text-foreground">
        Scope of the backup
      </p>
      <RadioGroup aria-labelledby={groupId} value={scope} onValueChange={setScope}>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={targetId} value="target" />
          <Label htmlFor={targetId}>This target</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={clusterId} value="cluster" />
          <Label htmlFor={clusterId}>The whole cluster</Label>
        </div>
      </RadioGroup>
      <p role="status" className="text-xs text-foreground-lighter">
        Chosen: {scope === 'target' ? 'this target' : 'the whole cluster'}.
      </p>
    </div>
  )
}

function Large(): ReactNode {
  return (
    <RadioGroup aria-label="Plan class" defaultValue="standard" className="flex flex-wrap gap-3">
      <RadioGroupLargeItem value="standard" label="Standard" />
      <RadioGroupLargeItem value="high" label="High: needs the typed path" />
      <RadioGroupLargeItem value="critical" label="Critical" disabled />
    </RadioGroup>
  )
}

function Cards(): ReactNode {
  return (
    <RadioGroupCard
      aria-label="Where to restore"
      defaultValue="new-database"
      className="flex flex-wrap gap-3"
    >
      <RadioGroupCardItem value="new-database" label="A new database" className="items-start">
        <Database aria-hidden className="size-5 text-foreground-light" />
      </RadioGroupCardItem>
      <RadioGroupCardItem value="new-cluster" label="A new cluster" className="items-start">
        <Server aria-hidden className="size-5 text-foreground-light" />
      </RadioGroupCardItem>
    </RadioGroupCard>
  )
}

function Stacked(): ReactNode {
  return (
    <div className="max-w-md">
      <RadioGroupStacked aria-label="Apply timing" defaultValue="window">
        <RadioGroupStackedItem
          value="now"
          label="Apply now"
          description="Runs as soon as the plan is approved."
        />
        <RadioGroupStackedItem
          value="window"
          label="Apply in the maintenance window"
          description="Waits for the next window of the cluster."
        />
        <RadioGroupStackedItem
          value="manual"
          label="Apply later"
          description="Keeps the approved plan until you apply it."
          disabled
        />
      </RadioGroupStacked>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/radio-group/plain',
    title: 'A radio group with labels',
    render: () => <Plain />,
  },
  {
    id: 'ui/radio-group/large',
    title: 'Large items for a short label',
    render: () => <Large />,
  },
  {
    id: 'ui/radio-group/card',
    title: 'Card items with an icon above the label',
    render: () => <Cards />,
  },
  {
    id: 'ui/radio-group/stacked',
    title: 'Stacked items with a description',
    render: () => <Stacked />,
  },
]
