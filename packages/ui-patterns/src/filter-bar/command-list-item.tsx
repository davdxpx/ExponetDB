// Derived from supabase/supabase packages/ui-patterns/src/FilterBar/CommandListItem.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Check } from '@exponetdb/icons'
import { CommandItem } from '@exponetdb/ui'

import { OperatorSymbolBadge } from './operator-symbol-badge.tsx'
import type { MenuItem } from './types.ts'

export type CommandListItemProps = {
  item: MenuItem
  /** Position in the list: the unique value the list tracks the highlighted option by. */
  index: number
  /** Marks options that are taken (used by another condition) with a check. */
  showSelection?: boolean
  onSelect: (item: MenuItem) => void
}

/** One option of a suggestion list. Labels are text only; a taken option is disabled. */
export function CommandListItem({
  item,
  index,
  showSelection = false,
  onSelect,
}: CommandListItemProps) {
  return (
    <CommandItem
      value={String(index)}
      disabled={item.disabled}
      onSelect={() => onSelect(item)}
      className="h-7 justify-between gap-2 px-2 text-xs"
    >
      <span className="flex min-w-0 items-center gap-2">
        {showSelection ? (
          item.disabled ? (
            <Check aria-hidden className="size-3.5 shrink-0 text-foreground-muted" />
          ) : (
            <span aria-hidden className="w-3.5 shrink-0" />
          )
        ) : null}
        {/* UntrustedText: option labels can come from the caller's data. */}
        <span className="truncate">{item.label}</span>
        {showSelection && item.disabled ? <span className="sr-only">(already used)</span> : null}
      </span>
      {item.count !== undefined ? (
        <span className="shrink-0 text-code-inline text-foreground-light">{item.count}</span>
      ) : null}
      {item.operatorSymbol ? <OperatorSymbolBadge symbol={item.operatorSymbol} /> : null}
    </CommandItem>
  )
}
