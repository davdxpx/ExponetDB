import { Toggle, ToggleGroup, ToggleGroupItem } from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Segmented(): ReactNode {
  const [range, setRange] = useState('hour')
  return (
    <Stack>
      <ToggleGroup
        type="single"
        variant="segmented"
        value={range}
        onValueChange={setRange}
        allowDeselect={false}
        aria-label="Time range"
      >
        <ToggleGroupItem value="hour" size="tiny">
          1 h
        </ToggleGroupItem>
        <ToggleGroupItem value="day" size="tiny">
          24 h
        </ToggleGroupItem>
        <ToggleGroupItem value="week" size="tiny">
          7 d
        </ToggleGroupItem>
      </ToggleGroup>
      <p role="status" className="text-xs text-foreground-lighter">
        Showing the last {range === 'hour' ? 'hour' : range === 'day' ? '24 hours' : '7 days'}.
      </p>
    </Stack>
  )
}

function Tones(): ReactNode {
  return (
    <Stack>
      {(['text', 'outline', 'primary'] as const).map((tone) => (
        <ToggleGroup
          key={tone}
          type="single"
          variant="segmented"
          tone={tone}
          defaultValue="plans"
          allowDeselect={false}
          aria-label={`View, ${tone} tone`}
        >
          <ToggleGroupItem value="plans" size="tiny">
            Plans
          </ToggleGroupItem>
          <ToggleGroupItem value="operations" size="tiny">
            Operations
          </ToggleGroupItem>
        </ToggleGroup>
      ))}
    </Stack>
  )
}

function Multiple(): ReactNode {
  return (
    <Row>
      <ToggleGroup type="multiple" variant="outline" size="tiny" aria-label="Operation states">
        <ToggleGroupItem value="running">Running</ToggleGroupItem>
        <ToggleGroupItem value="failed">Failed</ToggleGroupItem>
        <ToggleGroupItem value="waiting">Waiting for approval</ToggleGroupItem>
      </ToggleGroup>
    </Row>
  )
}

function Single(): ReactNode {
  return (
    <Row>
      <Toggle variant="outline" size="tiny" defaultPressed>
        Show system schemas
      </Toggle>
      <Toggle variant="outline" size="tiny" disabled>
        Show hidden columns
      </Toggle>
    </Row>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/toggle-group/segmented',
    title: 'A segmented control that always has one choice',
    render: () => <Segmented />,
  },
  { id: 'ui/toggle-group/tones', title: 'The three tones', render: () => <Tones /> },
  {
    id: 'ui/toggle-group/multiple',
    title: 'Several can be on at once',
    render: () => <Multiple />,
  },
  { id: 'ui/toggle-group/toggle', title: 'A single toggle', render: () => <Single /> },
]
