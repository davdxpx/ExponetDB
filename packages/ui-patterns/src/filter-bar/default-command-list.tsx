// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/DefaultCommandList.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Command, CommandGroup, CommandList } from '@exponetdb/ui'
import { type RefObject, useEffect, useMemo, useRef } from 'react'

import { CommandListItem } from './command-list-item.tsx'
import { type MenuItem, type MenuItemGroup, OPERATOR_GROUP_LABELS } from './types.ts'
import { groupMenuItemsByOperator } from './utils.ts'

/** What the owner of the input needs from the rendered list to describe it to assistive technology. */
export type ListBinding = {
  /** The id of the listbox (`aria-controls`). */
  listId: string | undefined
  /** The id of the highlighted option (`aria-activedescendant`). */
  activeId: string | undefined
}

export type DefaultCommandListProps = {
  items: MenuItem[]
  highlightedIndex: number
  onSelect: (item: MenuItem) => void
  /** Called when the pointer moves over another option. */
  onHighlight?: (index: number) => void
  /** Accessible name of the list ("Properties", "Operators", "Values"). */
  label: string
  /** Marks options that are taken with a check. */
  showSelection?: boolean
  /** Groups the options under headings by operator group. */
  grouped?: boolean
  /** Reports the listbox and highlighted option ids; `null` when the list goes away. */
  onBind?: (binding: ListBinding | null) => void
}

/**
 * Reports the ids that the text field needs (`aria-controls`, `aria-activedescendant`). They are
 * read from the rendered list after every commit: the highlighted option is controlled from
 * outside, and the list only tracks an id of its own for pointer and key events it handles itself.
 * `onBind` ignores a report that changes nothing, so reporting on every commit does not loop.
 */
function useListBinding(
  listRef: RefObject<HTMLDivElement | null>,
  highlightedIndex: number,
  onBind: ((binding: ListBinding | null) => void) | undefined,
) {
  useEffect(() => {
    if (!onBind) return
    const list = listRef.current
    const active = list?.querySelector(`[cmdk-item][data-value="${highlightedIndex}"]`)
    onBind({ listId: list?.id, activeId: active?.id || undefined })
  })
  useEffect(() => () => onBind?.(null), [onBind])
}

/**
 * The options of one suggestion list. The text field that owns the list keeps keyboard focus and
 * drives the highlight (`highlightedIndex`); this is a cmdk listbox, so options are announced as
 * `option`s of a named `listbox`.
 */
export function DefaultCommandList({
  items,
  highlightedIndex,
  onSelect,
  onHighlight,
  label,
  showSelection = false,
  grouped = false,
  onBind,
}: DefaultCommandListProps) {
  const listRef = useRef<HTMLDivElement>(null)

  const groups: MenuItemGroup[] = useMemo(() => {
    if (grouped) return groupMenuItemsByOperator(items)
    return [{ group: 'uncategorized', items: items.map((item, index) => ({ item, index })) }]
  }, [grouped, items])

  const showGroupHeadings = groups.length > 1

  useListBinding(listRef, highlightedIndex, onBind)

  // Keep the highlighted option in view when the arrow keys move it.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[cmdk-item][data-value="${highlightedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  const renderItem = ({ item, index }: { item: MenuItem; index: number }) => (
    <CommandListItem
      key={index}
      item={item}
      index={index}
      showSelection={showSelection}
      onSelect={onSelect}
    />
  )

  return (
    <Command
      shouldFilter={false}
      label={label}
      value={String(highlightedIndex)}
      onValueChange={(value) => {
        if (value !== '') onHighlight?.(Number(value))
      }}
      // Keep keyboard focus in the text field when an option is pressed.
      onMouseDown={(event) => event.preventDefault()}
      className="h-auto"
    >
      <CommandList label={label} ref={listRef} className="max-h-[300px] py-1">
        {showGroupHeadings
          ? groups.map((group) => (
              <CommandGroup key={group.group} heading={OPERATOR_GROUP_LABELS[group.group]}>
                {group.items.map(renderItem)}
              </CommandGroup>
            ))
          : groups.flatMap((group) => group.items).map(renderItem)}
      </CommandList>
    </Command>
  )
}
