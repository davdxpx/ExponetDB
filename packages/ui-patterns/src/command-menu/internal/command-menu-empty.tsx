// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/CommandMenuEmpty.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { cn } from '@exponetdb/ui'
import { useCommandState } from 'cmdk'

/**
 * The state line of the list, and its live region: when the search matches
 * nothing it says so on screen; while the search matches something it tells a
 * screen reader how many commands remain.
 *
 * The list does not count the entries that are mounted on every search
 * (`forceMount`), so the caller passes how many there are.
 */
const CommandMenuEmpty = ({
  className,
  forcedCount = 0,
}: {
  className?: string
  /** How many visible entries stay in the list whatever is typed. */
  forcedCount?: number
}) => {
  const searching = useCommandState((state) => state.search !== '')
  const matching = useCommandState((state) => state.filtered.count)
  const empty = matching + forcedCount === 0

  let text = ''
  if (empty) {
    text = searching ? 'No commands match your search.' : 'No commands are available here.'
  } else if (searching) {
    const total = matching + forcedCount
    text = `${total} ${total === 1 ? 'command matches' : 'commands match'} your search.`
  }

  return (
    <div
      role="status"
      className={cn(
        empty ? 'py-6 text-center text-sm text-foreground-muted' : 'sr-only',
        className,
      )}
    >
      {text}
    </div>
  )
}

export { CommandMenuEmpty }
