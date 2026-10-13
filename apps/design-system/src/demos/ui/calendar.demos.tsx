import { Calendar } from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'

/** The shape of the range the calendar reports (the library's own type is not a dependency here). */
interface DateRange {
  from: Date | undefined
  to?: Date | undefined
}

// A fixed month and a fixed "today" keep the demos deterministic.
const MONTH = new Date(2026, 9, 1)
const TODAY = new Date(2026, 9, 13)

const FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

function Single(): ReactNode {
  const [day, setDay] = useState<Date | undefined>(new Date(2026, 9, 20))
  return (
    <div className="flex flex-col gap-2">
      <Calendar
        mode="single"
        selected={day}
        onSelect={setDay}
        defaultMonth={MONTH}
        today={TODAY}
        className="w-fit rounded-md border border-default"
      />
      <p role="status" className="text-sm text-foreground-light">
        {day === undefined ? 'No day chosen.' : `Chosen: ${FORMAT.format(day)}.`}
      </p>
    </div>
  )
}

function Range(): ReactNode {
  const [range, setRange] = useState<DateRange | undefined>({
    from: new Date(2026, 9, 6),
    to: new Date(2026, 9, 12),
  })
  return (
    <div className="flex flex-col gap-2">
      <Calendar
        mode="range"
        selected={range}
        onSelect={setRange}
        defaultMonth={MONTH}
        today={TODAY}
        className="w-fit rounded-md border border-default"
      />
      <p role="status" className="text-sm text-foreground-light">
        {range?.from === undefined
          ? 'No range chosen.'
          : `From ${FORMAT.format(range.from)}${range.to === undefined ? '' : ` to ${FORMAT.format(range.to)}`}.`}
      </p>
    </div>
  )
}

function Limited(): ReactNode {
  const [day, setDay] = useState<Date | undefined>(undefined)
  return (
    <div className="flex flex-col gap-2">
      <Calendar
        mode="single"
        selected={day}
        onSelect={setDay}
        defaultMonth={MONTH}
        today={TODAY}
        disabled={{ before: TODAY }}
        showOutsideDays={false}
        className="w-fit rounded-md border border-default"
      />
      <p className="text-sm text-foreground-light">
        Days before today cannot be chosen: a maintenance window starts in the future.
      </p>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  { id: 'ui/calendar/single', title: 'Choose one day', render: () => <Single /> },
  { id: 'ui/calendar/range', title: 'Choose a range of days', render: () => <Range /> },
  {
    id: 'ui/calendar/limited',
    title: 'Days before today are disabled',
    render: () => <Limited />,
  },
]
