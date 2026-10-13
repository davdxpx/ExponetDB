import {
  Button,
  Checkbox,
  Label,
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverSeparator,
  PopoverTrigger,
} from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

const STATES = ['running', 'failed', 'waiting for approval'] as const

function StateOption({
  label,
  checked,
  onChange,
}: {
  readonly label: string
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
}): ReactNode {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  )
}

function Filters(): ReactNode {
  const [chosen, setChosen] = useState<readonly string[]>(['failed'])
  return (
    <Row>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Operation states ({chosen.length})</Button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">Show operations that are</p>
            <div className="flex flex-col gap-2">
              {STATES.map((state) => (
                <StateOption
                  key={state}
                  label={state}
                  checked={chosen.includes(state)}
                  onChange={(next) =>
                    setChosen((current) =>
                      next ? [...current, state] : current.filter((item) => item !== state),
                    )
                  }
                />
              ))}
            </div>
            <PopoverSeparator />
            <div className="flex justify-between gap-2">
              <Button variant="text" onClick={() => setChosen([])}>
                Clear filters
              </Button>
              <PopoverClose asChild>
                <Button variant="default">Done</Button>
              </PopoverClose>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <p className="text-sm text-foreground-light">{chosen.length} of 3 states shown.</p>
    </Row>
  )
}

function Anchored(): ReactNode {
  return (
    <Stack>
      <Popover>
        <PopoverAnchor asChild>
          <div className="flex w-72 items-center justify-between gap-2 rounded-md border border-control px-3 py-1.5 text-sm">
            <span>shop/platform/staging</span>
            <PopoverTrigger asChild>
              <Button variant="text" size="tiny">
                Details
              </Button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-72">
          <p className="text-sm text-foreground-light">
            The popover is placed under the whole row, not under the button that opened it.
          </p>
        </PopoverContent>
      </Popover>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/popover/filters',
    title: 'A popover with filters, clear and done',
    render: () => <Filters />,
    visual: false,
  },
  {
    id: 'ui/popover/anchor',
    title: 'A popover placed under a different element than its trigger',
    render: () => <Anchored />,
    visual: false,
  },
]
