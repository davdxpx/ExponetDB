// Derived from supabase/supabase packages/ui-patterns/src/DatePicker/DatePicker.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Calendar as CalendarIcon } from '@exponetdb/icons'
import {
  Button,
  Calendar,
  type CalendarProps,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exponetdb/ui'
import { type ComponentProps, type ReactNode, type Ref, useMemo, useState } from 'react'

const DatePickerIcon = <CalendarIcon className="h-4 w-4" />

export type DatePickerButtonProps = ComponentProps<typeof Button> & { isInvalid?: boolean }

/** The button that opens a calendar: left-aligned value, calendar icon, invalid state. */
export const DatePickerButton = ({
  className,
  variant = 'default',
  icon = DatePickerIcon,
  isInvalid = false,
  'aria-invalid': ariaInvalid,
  ...props
}: DatePickerButtonProps) => {
  return (
    <Button
      variant={variant}
      className={cn(
        'justify-start text-left font-normal px-3 py-4',
        'aria-[invalid=true]:bg-destructive-200 aria-[invalid=true]:border aria-[invalid=true]:border-destructive-400',
        className,
      )}
      icon={icon}
      aria-invalid={isInvalid ? true : ariaInvalid}
      {...props}
    />
  )
}

/** The popover that holds a calendar. */
export const DatePickerContent = ({
  className,
  align = 'start',
  ...props
}: ComponentProps<typeof PopoverContent>) => {
  return <PopoverContent className={cn('w-auto p-0', className)} align={align} {...props} />
}

/** A selected range of calendar days; `to` is missing while only the first day is chosen. */
export interface DatePickerRange {
  from: Date | undefined
  to?: Date | undefined
}

type DisabledMatcher = NonNullable<CalendarProps['disabled']>

interface DatePickerBaseProps {
  /**
   * What the date is for ("Start date", "Retention until"). It is the accessible name of the button
   * together with the chosen value, so it must be specific enough to tell pickers apart.
   */
  label: string
  /** Shown while nothing is chosen. Default: "Choose a date" or "Choose dates". */
  placeholder?: string
  disabled?: boolean
  /** Marks the button invalid (also set through `aria-invalid`, which `FormControl` passes). */
  invalid?: boolean
  /** The id of the button, so that a `<label htmlFor>` or `FormControl` can point at it. */
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'true' | 'false'
  /** Days before this day cannot be chosen, and the calendar cannot move before its month. */
  minDate?: Date
  /** Days after this day cannot be chosen, and the calendar cannot move past its month. */
  maxDate?: Date
  /** More days that cannot be chosen (react-day-picker matchers). */
  disabledDates?: DisabledMatcher
  /** BCP 47 tag of the date format (`Intl.DateTimeFormat`). Default `en-US`. */
  locale?: string
  /** Months shown side by side. Default 1 for a day, 2 for a range. */
  numberOfMonths?: number
  className?: string
  contentClassName?: string
  ref?: Ref<HTMLButtonElement>
}

export type DatePickerProps = DatePickerBaseProps &
  (
    | {
        mode?: 'single'
        value: Date | undefined
        onValueChange: (value: Date | undefined) => void
      }
    | {
        mode: 'range'
        value: DatePickerRange | undefined
        onValueChange: (value: DatePickerRange | undefined) => void
      }
  )

/** `2026-10-05` from the local calendar day of a date, for `<time dateTime>`. */
function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * A button that opens a calendar to choose one day or a range of days.
 *
 * - The dates are calendar days in the viewer's local time zone (a `Date` at local midnight).
 *   Convert at the boundary when a UTC day is meant.
 * - Keyboard: the button opens the calendar with Enter or Space; focus lands on the chosen day or
 *   today; the arrow keys, Home, End, Page Up and Page Down move between days and months; Enter
 *   or Space chooses; Escape closes and returns focus to the button.
 * - A day closes the calendar once chosen; a range closes when its second day is chosen.
 * - The value is shown as text through `Intl`, with `<time dateTime>` for each day.
 */
export function DatePicker(props: DatePickerProps) {
  const {
    label,
    placeholder,
    disabled = false,
    invalid,
    id,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    minDate,
    maxDate,
    disabledDates,
    locale = 'en-US',
    numberOfMonths,
    className,
    contentClassName,
    ref,
  } = props
  const [open, setOpen] = useState(false)
  const isRange = props.mode === 'range'
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    [locale],
  )

  const matchers = useMemo(
    () =>
      [
        minDate ? { before: minDate } : [],
        maxDate ? { after: maxDate } : [],
        disabledDates ?? [],
      ].flat(),
    [minDate, maxDate, disabledDates],
  )

  const day = (date: Date): ReactNode => (
    <time dateTime={isoDay(date)}>{formatter.format(date)}</time>
  )
  const dayText = (date: Date): string => formatter.format(date)

  let content: ReactNode
  let summary: string
  const emptyText = placeholder ?? (isRange ? 'Choose dates' : 'Choose a date')
  if (props.mode === 'range' && props.value?.from) {
    const { from, to } = props.value
    content = (
      <>
        {day(from)} to {to ? day(to) : <span aria-hidden>…</span>}
      </>
    )
    summary = `${dayText(from)} to ${to ? dayText(to) : 'end date not chosen'}`
  } else if (props.mode !== 'range' && props.value) {
    content = day(props.value)
    summary = dayText(props.value)
  } else {
    content = <span className="text-foreground-muted">{emptyText}</span>
    summary = emptyText
  }

  const calendarProps = {
    defaultMonth: props.mode === 'range' ? props.value?.from : props.value,
    disabled: matchers.length > 0 ? matchers : undefined,
    startMonth: minDate,
    endMonth: maxDate,
    numberOfMonths: numberOfMonths ?? (isRange ? 2 : 1),
    // Focus lands on the chosen day or today when the calendar opens.
    autoFocus: true,
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <DatePickerButton
          ref={ref}
          id={id}
          type="button"
          disabled={disabled}
          className={className}
          isInvalid={invalid ?? (ariaInvalid === true || ariaInvalid === 'true')}
          aria-describedby={ariaDescribedBy}
          aria-label={`${label}: ${summary}`}
        >
          {content}
        </DatePickerButton>
      </PopoverTrigger>
      <DatePickerContent
        aria-label={label}
        className={contentClassName}
        // The calendar focuses the chosen day itself; the popover must not focus its first button.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {props.mode === 'range' ? (
          <Calendar
            {...calendarProps}
            mode="range"
            resetOnSelect
            selected={props.value}
            onSelect={(range) => {
              props.onValueChange(range)
              if (range?.from && range.to) setOpen(false)
            }}
          />
        ) : (
          <Calendar
            {...calendarProps}
            mode="single"
            selected={props.value}
            onSelect={(date) => {
              props.onValueChange(date)
              setOpen(false)
            }}
          />
        )}
      </DatePickerContent>
    </Popover>
  )
}
