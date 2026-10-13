import { Label, Slider } from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Stack } from './support.tsx'

function Single(): ReactNode {
  const id = useId()
  const [value, setValue] = useState([30])
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label id={id}>Statement timeout</Label>
        <span className="font-mono text-xs text-foreground">{value[0]} s</span>
      </div>
      <Slider
        aria-labelledby={id}
        value={value}
        onValueChange={setValue}
        min={5}
        max={120}
        step={5}
      />
      <p className="text-xs text-foreground-lighter">From 5 to 120 seconds, in steps of 5.</p>
    </div>
  )
}

function Range(): ReactNode {
  const [value, setValue] = useState([10, 60])
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm">Sample window</span>
        <span className="font-mono text-xs text-foreground">
          {value[0]} to {value[1]} minutes
        </span>
      </div>
      <Slider
        value={value}
        onValueChange={setValue}
        min={0}
        max={120}
        step={5}
        thumbLabels={['Window start in minutes', 'Window end in minutes']}
      />
    </div>
  )
}

function Disabled(): ReactNode {
  return (
    <Stack className="w-full max-w-sm">
      <Slider defaultValue={[40]} disabled aria-label="Sample rate, set by policy" />
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  { id: 'ui/slider/single', title: 'One thumb with its value as text', render: () => <Single /> },
  { id: 'ui/slider/range', title: 'A range with two named thumbs', render: () => <Range /> },
  { id: 'ui/slider/disabled', title: 'Disabled', render: () => <Disabled /> },
]
