// Derived from supabase/supabase packages/ui-patterns/src/multi-select/multi-select.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Check, ChevronDown, X } from '@exponetdb/icons'
import {
  Badge,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  type ControlSize,
  cn,
  controlRadiusBySize,
  Popover,
  PopoverAnchor,
  PopoverContent,
  type PopoverContentProps,
  PopoverTrigger,
  SIZE,
} from '@exponetdb/ui'
import {
  Children,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  createContext,
  type ForwardRefExoticComponent,
  forwardRef,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  type RefAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

import { SelectionListState } from '../selection-list-state/index.ts'

/**
 * A multi-select with a search list.
 *
 * ```tsx
 * <MultiSelector label="Environments" values={values} onValuesChange={setValues}>
 *   <MultiSelectorTrigger label="Select environments" />
 *   <MultiSelectorContent>
 *     <MultiSelectorInput placeholder="Search environments" />
 *     <MultiSelectorList>
 *       <MultiSelectorItem value="staging">staging</MultiSelectorItem>
 *     </MultiSelectorList>
 *   </MultiSelectorContent>
 * </MultiSelector>
 * ```
 *
 * Accessibility:
 * - the trigger is a `combobox` button (`aria-expanded`, `aria-controls`, `aria-haspopup`) that
 *   opens a popover with a search field and a `listbox` of options (`aria-multiselectable`; a
 *   selected option has `aria-checked` and a check mark, so selection is not shown by color);
 * - selected values are chips in a list next to the button, each with its own "Remove <value>"
 *   button, outside the combobox so that no control is nested in another;
 * - choosing or removing a value is announced ("Staging added, 2 selected");
 * - focus returns to the trigger when the list closes, and moves to a neighbouring chip (or the
 *   trigger) when a chip is removed.
 *
 * Values, option text and the text of a created value come from data and render as text only.
 */

interface ControlProps {
  id: string | undefined
  'aria-describedby': string | undefined
  'aria-invalid': ComponentPropsWithoutRef<'button'>['aria-invalid']
}

interface MultiSelectContextProps {
  values: string[]
  toggleValue: (value: string) => void
  open: boolean
  setOpen: (open: boolean) => void
  inputValue: string
  setInputValue: (value: string) => void
  size: ControlSize
  disabled: boolean
  label: string | undefined
  searchLabel: string
  controlProps: ControlProps
  commandProps: Pick<ComponentPropsWithoutRef<typeof Command>, 'filter' | 'shouldFilter' | 'loop'>
}

const MultiSelectContext = createContext<MultiSelectContextProps | null>(null)

const DROPDOWN_GAP = 8

const commandItemClass = cn(
  'relative text-foreground-light text-left px-2 py-1.5 rounded-item',
  'hover:text-foreground hover:bg-overlay-hover! w-full flex items-center space-x-2',
)

function useMultiSelect() {
  const context = useContext(MultiSelectContext)
  if (!context) {
    throw new Error('useMultiSelect must be used within a MultiSelector')
  }
  return context
}

const FIELD_SIZE: Record<ControlSize, string> = {
  tiny: `${SIZE.text.tiny} ${SIZE.minHeight.tiny} ${controlRadiusBySize.tiny}`,
  small: `${SIZE.text.small} ${SIZE.minHeight.small} ${controlRadiusBySize.small}`,
  medium: `${SIZE.text.medium} ${SIZE.minHeight.medium} ${controlRadiusBySize.medium}`,
  large: `${SIZE.text.large} ${SIZE.minHeight.large} ${controlRadiusBySize.large}`,
}

/** Padding of the field: less on the left while chips are shown, so they align with the border. */
const FIELD_PADDING: Record<ControlSize, { empty: string; filled: string }> = {
  tiny: { empty: 'pl-2.5 pr-2.5 py-0.5', filled: 'pl-0.5 pr-2.5 py-0.5' },
  small: { empty: 'pl-3 pr-3 py-1.5', filled: 'pl-1.5 pr-3 py-1.5' },
  medium: { empty: SIZE.padding.medium, filled: SIZE.padding.medium },
  large: { empty: SIZE.padding.large, filled: SIZE.padding.large },
}

export interface MultiSelectorProps
  extends Pick<ComponentPropsWithoutRef<typeof Command>, 'filter' | 'shouldFilter' | 'loop'> {
  values: string[]
  onValuesChange: (value: string[]) => void
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  size?: ControlSize
  /**
   * What is chosen ("Environments"). Names the popover and the list of options, and the
   * trigger when it has no `label` of its own.
   */
  label?: string
  /** Accessible name of the search field. Default "Search options". */
  searchLabel?: string
  /** The id of the trigger, so that a `<label htmlFor>` or `FormControl` can point at it. */
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: ComponentPropsWithoutRef<'button'>['aria-invalid']
  dir?: 'ltr' | 'rtl'
  className?: string
  children?: ReactNode
}

function MultiSelector({
  values = [],
  onValuesChange,
  onOpenChange,
  disabled = false,
  size = 'small',
  label,
  searchLabel = 'Search options',
  id,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  dir,
  className,
  children,
  filter,
  shouldFilter,
  loop,
}: MultiSelectorProps) {
  const [open, setOpenState] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [announcement, setAnnouncement] = useState('')

  const setOpen = useCallback(
    (next: boolean) => {
      if (next === open) return
      // Each opening starts with an empty search.
      if (next) setInputValue('')
      setOpenState(next)
      onOpenChange?.(next)
    },
    [open, onOpenChange],
  )

  const toggleValue = useCallback(
    (toggled: string) => {
      const selected = values.includes(toggled)
      const next = selected ? values.filter((value) => value !== toggled) : [...values, toggled]
      onValuesChange(next)
      // UntrustedText: a value is data; it is spoken as text.
      setAnnouncement(
        `${toggled} ${selected ? 'removed' : 'added'}, ${next.length === 0 ? 'none' : next.length} selected`,
      )
    },
    [values, onValuesChange],
  )

  const context = useMemo<MultiSelectContextProps>(
    () => ({
      values,
      toggleValue,
      open,
      setOpen,
      inputValue,
      setInputValue,
      size,
      disabled,
      label,
      searchLabel,
      controlProps: { id, 'aria-describedby': ariaDescribedBy, 'aria-invalid': ariaInvalid },
      commandProps: { filter, shouldFilter, loop },
    }),
    [
      values,
      toggleValue,
      open,
      setOpen,
      inputValue,
      size,
      disabled,
      label,
      searchLabel,
      id,
      ariaDescribedBy,
      ariaInvalid,
      filter,
      shouldFilter,
      loop,
    ],
  )

  return (
    <MultiSelectContext.Provider value={context}>
      <Popover open={open} onOpenChange={setOpen}>
        <div dir={dir} className={cn('relative flex flex-col', className)}>
          {children}
          <span role="status" className="sr-only">
            {announcement}
          </span>
        </div>
      </Popover>
    </MultiSelectContext.Provider>
  )
}

export interface MultiSelectorTriggerProps
  extends Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'role'> {
  /** The text of the empty field ("Select environments"); also the name of the trigger. */
  label?: string
  /** Keep showing the label next to the chips. */
  persistLabel?: boolean
  /** Shows at most this many chips and "+n" for the rest, or all of them, wrapped, for `'wrap'`. */
  badgeLimit?: number | 'wrap'
  wrapBadges?: boolean
  /** Gives each chip a remove button. Default true. */
  deletableBadge?: boolean
  showIcon?: boolean
  /** How a value is shown in its chip. Text from data: render it as text. */
  renderValue?: (value: string) => ReactNode
  /** The plain text of a value for the name of its remove button. Default: the value. */
  valueLabel?: (value: string) => string
}

const MultiSelectorTrigger = forwardRef<HTMLButtonElement, MultiSelectorTriggerProps>(
  (
    {
      label,
      persistLabel = false,
      className,
      deletableBadge = true,
      badgeLimit = 9999,
      wrapBadges = false,
      showIcon = true,
      renderValue,
      valueLabel,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const {
      values,
      toggleValue,
      disabled,
      open,
      setOpen,
      size,
      controlProps,
      label: groupLabel,
    } = useMultiSelect()

    const chipsRef = useRef<HTMLUListElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    // The chip that had focus when it was removed: focus moves to its neighbour afterwards.
    const focusAfterRemove = useRef<number | null>(null)

    const wrap = wrapBadges || badgeLimit === 'wrap'
    const numericLimit = typeof badgeLimit === 'number'
    const visible = numericLimit ? values.slice(0, Math.max(0, badgeLimit)) : values
    const hiddenCount = values.length - visible.length
    const hasValues = values.length > 0
    const textOf = (value: string) => valueLabel?.(value) ?? value

    const setButtonRef = useCallback(
      (element: HTMLButtonElement | null) => {
        buttonRef.current = element
        if (typeof ref === 'function') ref(element)
        else if (ref) ref.current = element
      },
      [ref],
    )

    // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every change of the values
    useEffect(() => {
      const index = focusAfterRemove.current
      if (index === null) return
      focusAfterRemove.current = null
      const buttons = Array.from(chipsRef.current?.querySelectorAll('button') ?? [])
      const target = buttons[Math.min(index, buttons.length - 1)]
      ;(target ?? buttonRef.current)?.focus()
    }, [values])

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        setOpen(true)
      } else if (!open && (event.key === 'Backspace' || event.key === 'Delete') && hasValues) {
        event.preventDefault()
        const last = values[values.length - 1]
        if (last !== undefined) toggleValue(last)
      }
    }

    const showLabelText = !hasValues || persistLabel
    const buttonText = label ?? groupLabel
    // A combobox takes its name from `aria-label`/`aria-labelledby` or a `<label>`, never from its
    // content, so the text is also what names the button unless the caller names it otherwise.
    const textId = useId()
    const namedByCaller =
      props['aria-label'] !== undefined || props['aria-labelledby'] !== undefined
    const filled = hasValues
    const chipClass = cn(
      'rounded-sm shrink-0 px-1.5 bg-surface-75 normal-case tracking-normal text-xs/none',
      size === 'tiny' ? 'py-0' : 'py-px',
      deletableBadge && !disabled && (size === 'tiny' ? 'pr-px' : 'pr-0.5'),
    )

    return (
      <PopoverAnchor asChild>
        <div
          data-state={open ? 'open' : 'closed'}
          className={cn(
            'flex w-full min-w-50 items-center gap-1',
            // Empty: raised plate. Filled: sunk well for chips.
            filled
              ? 'border border-strong bg-field hover:border-control-hover'
              : 'border-0 control-surface-shadows raised-control-surface',
            'transition-colors duration-200',
            open && filled && 'border-control-hover',
            disabled && 'cursor-not-allowed opacity-50',
            wrap && 'flex-wrap',
            FIELD_SIZE[size],
            filled ? FIELD_PADDING[size].filled : FIELD_PADDING[size].empty,
          )}
        >
          {hasValues ? (
            <ul
              ref={chipsRef}
              aria-label={groupLabel ? `${groupLabel}, selected` : 'Selected options'}
              className={cn(
                wrap ? 'contents' : 'flex min-w-0 gap-1 overflow-x-auto',
                !wrap && 'items-center',
              )}
            >
              {visible.map((value, index) => (
                <li key={value} className={cn('shrink-0', wrap && 'max-w-full')}>
                  <Badge className={cn(chipClass, 'max-w-full')}>
                    {/* UntrustedText: a value is data; the chip shows it as text. */}
                    <span className="min-w-0 wrap-anywhere">{renderValue?.(value) ?? value}</span>
                    {deletableBadge && !disabled ? (
                      <button
                        type="button"
                        aria-label={`Remove ${textOf(value)}`}
                        onClick={() => {
                          focusAfterRemove.current = index
                          toggleValue(value)
                        }}
                        className="ml-1 p-0.5 rounded-xs text-foreground-lighter hover:text-foreground-light hover:bg-surface-400 transition-colors focus-ring hit-area-1"
                      >
                        <X size={12} aria-hidden />
                      </button>
                    ) : null}
                  </Badge>
                </li>
              ))}
              {hiddenCount > 0 ? (
                <li className="shrink-0">
                  <Badge className={chipClass}>
                    {numericLimit && badgeLimit < 1 ? (
                      `${hiddenCount} ${hiddenCount === 1 ? 'item' : 'items'} selected`
                    ) : (
                      <>
                        <span aria-hidden>+{hiddenCount}</span>
                        <span className="sr-only">{hiddenCount} more selected</span>
                      </>
                    )}
                  </Badge>
                </li>
              ) : null}
            </ul>
          ) : null}
          <PopoverTrigger asChild>
            <button
              ref={setButtonRef}
              type="button"
              role="combobox"
              aria-expanded={open}
              disabled={disabled}
              className={cn(
                'flex min-w-10 flex-1 items-center justify-between gap-1.5 self-stretch text-left outline-hidden focus-ring rounded-sm',
                'disabled:cursor-not-allowed',
                className,
              )}
              aria-labelledby={!namedByCaller && buttonText !== undefined ? textId : undefined}
              {...controlProps}
              {...props}
              onKeyDown={handleKeyDown}
            >
              <span
                id={textId}
                className={cn(
                  showLabelText && label !== undefined
                    ? 'truncate text-foreground-muted'
                    : 'sr-only',
                )}
              >
                {buttonText}
              </span>
              {showIcon ? (
                <ChevronDown
                  aria-hidden="true"
                  size={16}
                  strokeWidth={1.5}
                  className="text-foreground-lighter shrink-0 ml-auto"
                />
              ) : null}
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
    )
  },
)
MultiSelectorTrigger.displayName = 'MultiSelectorTrigger'
MultiSelector.Trigger = MultiSelectorTrigger

const MultiSelectorInput = forwardRef<
  ComponentRef<typeof CommandInput>,
  ComponentPropsWithoutRef<typeof CommandInput> & {
    showResetIcon?: boolean
    showSearchIcon?: boolean
    wrapperClassName?: string
  }
>(({ className, wrapperClassName, showResetIcon, showSearchIcon, onKeyDown, ...props }, ref) => {
  const { inputValue, setInputValue, disabled, values, toggleValue } = useMultiSelect()
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleReset = () => {
    setInputValue('')
    inputRef.current?.focus()
  }

  const setInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      inputRef.current = element
      if (typeof ref === 'function') ref(element)
      else if (ref) ref.current = element
    },
    [ref],
  )

  return (
    <CommandInput
      ref={setInputRef}
      value={inputValue}
      onValueChange={setInputValue}
      disabled={disabled}
      showSearchIcon={showSearchIcon}
      showResetIcon={showResetIcon}
      handleReset={handleReset}
      wrapperClassName={wrapperClassName}
      className={cn(
        'bg-transparent h-full grow border-none outline-hidden placeholder:text-foreground-muted flex-1',
        className,
      )}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        // Backspace in an empty search removes the last chosen value, as in a tag field.
        if (event.key === 'Backspace' && inputValue.length === 0 && values.length > 0) {
          const last = values[values.length - 1]
          if (last !== undefined) toggleValue(last)
        }
      }}
      {...props}
    />
  )
})
MultiSelectorInput.displayName = 'MultiSelectorInput'
MultiSelector.Input = MultiSelectorInput

// Annotated: the inferred type would name a type of the Radix package that is not exported.
const MultiSelectorContent: ForwardRefExoticComponent<
  PopoverContentProps & RefAttributes<HTMLDivElement>
> = forwardRef<HTMLDivElement, PopoverContentProps>(({ className, children, ...props }, ref) => {
  const { label, searchLabel, commandProps } = useMultiSelect()
  return (
    <PopoverContent
      align="start"
      collisionPadding={DROPDOWN_GAP}
      ref={ref}
      sideOffset={DROPDOWN_GAP}
      aria-label={label ?? 'Options'}
      className={cn('bg-overlay shadow-md z-50 border rounded-md p-0', className)}
      sameWidthAsTrigger
      {...props}
    >
      <Command label={searchLabel} {...commandProps}>
        {children}
      </Command>
    </PopoverContent>
  )
})
MultiSelectorContent.displayName = 'MultiSelectorContent'
MultiSelector.Content = MultiSelectorContent

/** The lower-cased `value` props of the direct children, to tell whether a typed value exists. */
function optionValues(children: ReactNode): string[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ value?: unknown }>(child)) return []
    const value = child.props.value
    return typeof value === 'string' && value !== '' ? [value.toLowerCase()] : []
  })
}

const MultiSelectorList = forwardRef<
  ComponentRef<typeof CommandList>,
  ComponentPropsWithoutRef<typeof CommandList> & {
    /** A typed value that is not an option can be added. */
    creatable?: boolean
    emptyLabel?: string
    /** The options could not be read. A failed read is shown as a failure, never as "no options". */
    error?: boolean
    errorLabel?: string
    loading?: boolean
  }
>(
  (
    {
      className,
      children,
      creatable = false,
      emptyLabel = 'No results found',
      error = false,
      errorLabel,
      loading = false,
      ...props
    },
    ref,
  ) => {
    const { inputValue, setInputValue, toggleValue, label } = useMultiSelect()

    const options = Children.toArray(children)
    const isOptionExists = optionValues(children).some(
      (value) => value === inputValue.toLowerCase(),
    )

    return (
      <>
        {/* Outside the listbox: a listbox may only own options and groups. */}
        <SelectionListState
          isLoading={loading}
          isError={error}
          isEmpty={!loading && !error && options.length === 0 && !creatable}
          emptyLabel={emptyLabel}
          errorLabel={errorLabel}
          skeletonVariant="multi-select"
        />
        <CommandList
          ref={ref}
          label={label ?? 'Options'}
          aria-multiselectable="true"
          className={cn(
            'p-1 flex flex-col w-full overflow-y-auto',
            // Never taller than the room below (or above) the field.
            'max-h-[min(300px,calc(var(--radix-popover-content-available-height)_-_2px))]',
            className,
          )}
          {...props}
        >
          {!loading && !error && (options.length > 0 || creatable) ? (
            <>
              {children}
              {creatable && inputValue.length > 0 && !isOptionExists ? (
                <CommandItem
                  onSelect={() => {
                    toggleValue(inputValue)
                    setInputValue('')
                  }}
                  className={commandItemClass}
                >
                  {/* UntrustedText: the typed value is data. */}
                  Create "{inputValue}"
                </CommandItem>
              ) : creatable && options.length === 0 ? (
                <div
                  role="presentation"
                  className="p-2 py-1.5 text-xs text-foreground-lighter italic"
                >
                  Type to add a value
                </div>
              ) : (
                <CommandEmpty>
                  <span className="text-foreground-muted">{emptyLabel}</span>
                </CommandEmpty>
              )}
            </>
          ) : null}
        </CommandList>
      </>
    )
  },
)
MultiSelectorList.displayName = 'MultiSelectorList'
MultiSelector.List = MultiSelectorList

const MultiSelectorItem = forwardRef<
  HTMLDivElement,
  { value: string } & Omit<ComponentPropsWithoutRef<typeof CommandItem>, 'value'>
>(({ className, value, children, ...props }, ref) => {
  const { values, setInputValue, toggleValue } = useMultiSelect()
  const isSelected = values.includes(value)

  return (
    <CommandItem
      ref={ref}
      // Typing the raw value finds the option even when it is shown under another name.
      keywords={[value]}
      aria-checked={isSelected}
      onSelect={() => {
        toggleValue(value)
        setInputValue('')
      }}
      className={cn(commandItemClass, className)}
      {...props}
    >
      <div
        aria-hidden
        className={cn(
          'flex items-center justify-center',
          'h-4 w-4 shrink-0 rounded-sm border border-control bg-control/25',
          'transition-colors duration-150 ease-in-out',
          isSelected ? 'bg-foreground text-background-overlay' : '[&_svg]:invisible',
        )}
      >
        <Check className="h-3 w-3" strokeWidth={4} />
      </div>
      <div className="text-sm grow leading-none wrap-anywhere">{children}</div>
    </CommandItem>
  )
})
MultiSelectorItem.displayName = 'MultiSelectorItem'
MultiSelector.Item = MultiSelectorItem

export {
  MultiSelector,
  MultiSelectorContent,
  MultiSelectorInput,
  MultiSelectorItem,
  MultiSelectorList,
  MultiSelectorTrigger,
}
