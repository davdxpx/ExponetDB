import { cn, Popover, PopoverAnchor, PopoverContent } from '@exponetdb/ui'
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useId,
  useState,
} from 'react'

import { DefaultCommandList, type ListBinding } from './default-command-list.tsx'
import type { MenuItem } from './types.ts'

/**
 * The combobox attributes the text field in the anchor takes (ARIA 1.2 editable combobox). A field
 * that never has a popup (free text) takes none, so it is announced as the plain text field it is.
 */
export type ComboboxAria = {
  role: 'combobox' | undefined
  'aria-expanded': boolean | undefined
  'aria-haspopup': 'listbox' | 'dialog' | undefined
  'aria-controls': string | undefined
  'aria-activedescendant': string | undefined
  'aria-autocomplete': 'list' | 'none' | undefined
}

/** Whether the suggestions of a property are being loaded, or could not be. */
export type SuggestionStatus = 'loading' | 'failed'

export type SuggestionPopoverProps = {
  open: boolean
  /** False for a field that never offers anything (a free-text value): no combobox attributes. */
  hasPopup?: boolean
  items: MenuItem[]
  highlightedIndex: number
  onHighlight: (index: number) => void
  onSelect: (item: MenuItem) => void
  /** Accessible name of the list ("Properties", "Operators", "Values"). */
  listLabel: string
  grouped?: boolean
  showSelection?: boolean
  /** Shown with the options while suggestions load, or instead of them when the load failed. */
  status?: SuggestionStatus | null
  /** The caller's own picker; replaces the list (the popup is then a dialog, not a listbox). */
  custom?: ReactNode
  /** The bar's wrapper: a click outside both it and the popup counts as leaving the bar. */
  wrapperRef: RefObject<HTMLElement | null>
  onClickOutside: () => void
  contentClassName?: string
  /** The anchor: renders the text field with the combobox attributes. */
  children: (aria: ComboboxAria) => ReactElement
}

/**
 * A text field (the anchor) with the popup of options it controls. The field keeps focus; the
 * highlighted option is announced through `aria-activedescendant`.
 */
export function SuggestionPopover({
  open,
  hasPopup = true,
  items,
  highlightedIndex,
  onHighlight,
  onSelect,
  listLabel,
  grouped,
  showSelection,
  status = null,
  custom,
  wrapperRef,
  onClickOutside,
  contentClassName,
  children,
}: SuggestionPopoverProps) {
  const [binding, setBinding] = useState<ListBinding | null>(null)
  const popupId = useId()
  const isCustom = custom !== undefined
  const hasItems = items.length > 0
  // The popup of the combobox is the list of options, or the caller's picker. A status line alone
  // (loading, failed) is not one: it is announced by its own live region.
  const isExpanded = open && (isCustom || hasItems)

  // Report a change only: the list reports after every commit.
  const bind = useCallback((next: ListBinding | null) => {
    setBinding((prev) =>
      prev?.listId === next?.listId && prev?.activeId === next?.activeId ? prev : next,
    )
  }, [])

  const aria: ComboboxAria = hasPopup
    ? {
        role: 'combobox',
        'aria-expanded': isExpanded,
        'aria-haspopup': isCustom ? 'dialog' : 'listbox',
        'aria-controls': isExpanded ? (isCustom ? popupId : binding?.listId) : undefined,
        'aria-activedescendant': isExpanded && !isCustom ? binding?.activeId : undefined,
        'aria-autocomplete': isCustom ? 'none' : 'list',
      }
    : {
        role: undefined,
        'aria-expanded': undefined,
        'aria-haspopup': undefined,
        'aria-controls': undefined,
        'aria-activedescendant': undefined,
        'aria-autocomplete': undefined,
      }

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>{children(aria)}</PopoverAnchor>
      <PopoverContent
        // A list is the popup of the combobox, not a dialog; the caller's picker is one.
        role={isCustom ? 'dialog' : 'presentation'}
        id={popupId}
        aria-label={isCustom ? listLabel : undefined}
        className={cn('min-w-[220px] p-0', contentClassName)}
        align="start"
        side="bottom"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          const target = event.target
          if (
            target instanceof Node &&
            wrapperRef.current &&
            !wrapperRef.current.contains(target)
          ) {
            onClickOutside()
          }
        }}
      >
        {isCustom ? (
          custom
        ) : (
          <>
            {status === 'loading' ? (
              <div role="status" className="px-2 py-1.5 text-xs text-foreground-lighter">
                Loading suggestions
              </div>
            ) : null}
            {status === 'failed' ? (
              <div role="alert" className="px-2 py-1.5 text-xs text-destructive">
                Could not load suggestions
              </div>
            ) : null}
            {hasItems ? (
              <DefaultCommandList
                items={items}
                highlightedIndex={highlightedIndex}
                onHighlight={onHighlight}
                onSelect={onSelect}
                label={listLabel}
                grouped={grouped}
                showSelection={showSelection}
                onBind={bind}
              />
            ) : null}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
