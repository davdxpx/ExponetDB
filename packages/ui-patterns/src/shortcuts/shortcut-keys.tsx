import { KeyboardShortcut } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { useShortcutPlatform } from './context.ts'
import { SHORTCUT_DEFINITIONS, type ShortcutBinding, type ShortcutId } from './definitions.ts'
import { CHORD_ENTER, spokenBinding } from './registry.ts'

/**
 * The keys of a shortcut as pills. Screen readers get the words ("G then P"), the
 * pills are hidden from them, so the keys are never announced letter by letter.
 */
export function ShortcutKeys({ shortcut }: { shortcut: ShortcutId }): ReactNode {
  const apple = useShortcutPlatform()
  const { binding } = SHORTCUT_DEFINITIONS[shortcut]
  return (
    <span className="inline-flex items-center">
      <span className="sr-only">{spokenBinding(binding, apple)}</span>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        <Pills binding={binding} />
      </span>
    </span>
  )
}

function Pills({ binding }: { binding: ShortcutBinding }): ReactNode {
  switch (binding.type) {
    case 'chord':
      return (
        <KeyboardShortcut keys={['Meta', binding.key === CHORD_ENTER ? 'Enter' : binding.key]} />
      )
    case 'key':
      return <KeyboardShortcut keys={[binding.key]} />
    case 'sequence':
      return (
        <>
          <KeyboardShortcut keys={[binding.keys[0]]} />
          <span className="text-[11px] text-foreground-muted">then</span>
          <KeyboardShortcut keys={[binding.keys[1]]} />
        </>
      )
  }
}
