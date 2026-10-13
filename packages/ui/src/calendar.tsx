// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/calendar.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronLeft, ChevronRight } from '@exponetdb/icons'
import type { ComponentProps } from 'react'
import { DayPicker } from 'react-day-picker'

import { buttonVariants } from './button.tsx'
import { cn } from './lib/utils.ts'

export type CalendarProps = ComponentProps<typeof DayPicker>

type ChevronProps = {
  className?: string
  orientation?: 'up' | 'down' | 'left' | 'right'
}

// Defined once, outside Calendar: a component created during render would remount on every render.
function CalendarChevron({ className, orientation }: ChevronProps) {
  const Icon = orientation === 'left' ? ChevronLeft : ChevronRight
  return <Icon aria-hidden className={cn('h-4 w-4 pointer-events-none', className)} />
}

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  const fullDateRangeSelected =
    props.mode === 'range' && !!props.selected?.from && !!props.selected?.to

  const {
    months,
    month,
    month_caption,
    caption_label,
    button_previous,
    button_next,
    month_grid,
    weekdays,
    weekday,
    week,
    day,
    day_button,
    selected,
    today,
    outside,
    disabled,
    range_start,
    range_middle,
    range_end,
    hidden,
    ...restClassNames
  } = classNames ?? {}

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: cn(
          'relative flex flex-col sm:flex-row space-y-4 sm:[&>*:not(nav)+*]:ml-4 sm:space-y-0',
          months,
        ),
        month: cn('space-y-4', month),
        month_caption: cn('flex justify-center pt-1 relative items-center', month_caption),
        caption_label: cn('text-sm font-medium', caption_label),
        button_previous: cn(
          buttonVariants({ variant: 'outline' }),
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100',
          'z-5',
          'aria-disabled:opacity-25 aria-disabled:hover:opacity-25 aria-disabled:cursor-not-allowed',
          'absolute left-0 top-0',
          button_previous,
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline' }),
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100',
          'z-5',
          'aria-disabled:opacity-25 aria-disabled:hover:opacity-25 aria-disabled:cursor-not-allowed',
          'absolute right-0 top-0',
          button_next,
        ),
        month_grid: cn('w-full border-collapse space-y-1', month_grid),
        weekdays: cn('flex', weekdays),
        weekday: cn('text-foreground-muted rounded-md w-9 font-normal text-[0.8rem]', weekday),
        week: cn('flex w-full mt-2', week),
        // react-day-picker 9 puts aria-selected on the cell (role gridcell), not on the button.
        day: cn(
          'text-center text-sm p-0 relative',
          'first:aria-selected:rounded-l-md last:aria-selected:rounded-r-md',
          'focus-within:relative focus-within:z-20',
          'w-9 box-border',
          day,
        ),
        day_button: cn(
          buttonVariants({ variant: 'text' }),
          'h-9 w-9 p-0 text-sm font-normal rounded-md',
          // Keep selected days from picking up the text variant's hover bg/text
          'in-aria-selected:opacity-100 in-aria-selected:hover:bg-transparent in-aria-selected:hover:text-inherit',
          day_button,
        ),
        selected: cn(
          !fullDateRangeSelected &&
            'bg-primary-bright/70! dark:bg-primary-bright/25! text-foreground rounded-md',
          selected,
        ),
        // Plain accent — range/selected fills use ! so they still win when today is in the selection
        today: cn('bg-accent text-accent-foreground', today),
        outside: cn(
          'text-foreground-muted opacity-50 aria-selected:opacity-100 aria-selected:text-foreground',
          outside,
        ),
        disabled: cn('text-foreground-muted opacity-50', disabled),
        range_start: cn(
          fullDateRangeSelected &&
            'bg-primary-bright/70! dark:bg-primary-bright/25! text-foreground rounded-l-md',
          range_start,
        ),
        range_middle: cn(
          'bg-primary-bright/25! dark:bg-primary-bright/12! text-foreground rounded-none',
          range_middle,
        ),
        range_end: cn(
          fullDateRangeSelected &&
            'bg-primary-bright/70! dark:bg-primary-bright/25! text-foreground rounded-r-md',
          range_end,
        ),
        hidden: cn('invisible', hidden),
        ...restClassNames,
      }}
      components={{ Chevron: CalendarChevron }}
      {...props}
    />
  )
}
Calendar.displayName = 'Calendar'

export { Calendar }
