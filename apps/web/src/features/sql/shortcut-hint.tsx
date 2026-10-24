import { KeyboardShortcut } from '@exponetdb/ui'
import { SHORTCUT_DEFINITIONS, type ShortcutId, useShortcutPlatform } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

/**
 * The keys of a registered shortcut on a button, taken from the registry
 * (`SHORTCUT_DEFINITIONS`) and from the platform the shortcut provider decided
 * on, so the hint on the button and the shortcut that runs are one definition:
 * Command on Apple platforms, Control elsewhere. (`ShortcutKeys` of the
 * registry draws pills and leaves the modifier to the key component's own
 * detection of the platform; the provider's choice, which can be overridden,
 * is what the shortcut obeys, so it is what the hint reads.)
 *
 * The hint is for the eyes: a button holds it in its decorative icon slot.
 * What a screen reader is told is `useAriaKeyShortcuts`, set on the button as
 * `aria-keyshortcuts`.
 */
export function ShortcutHint(props: { readonly shortcut: ShortcutId }): ReactNode {
  const apple = useShortcutPlatform()
  const { binding } = SHORTCUT_DEFINITIONS[props.shortcut]
  if (binding.type !== 'chord') return null
  // The registry names the Enter chord `enter`; the key component shows the key's own symbol.
  const key = binding.key === 'enter' ? 'Enter' : binding.key
  return <KeyboardShortcut keys={[apple ? '⌘' : 'Ctrl', key]} variant="inline" />
}

/** The `aria-keyshortcuts` value of a registered chord for the platform: `Control+Enter`, `Meta+S`. */
export function useAriaKeyShortcuts(shortcut: ShortcutId): string | undefined {
  const apple = useShortcutPlatform()
  const { binding } = SHORTCUT_DEFINITIONS[shortcut]
  if (binding.type !== 'chord') return undefined
  const key = binding.key === 'enter' ? 'Enter' : binding.key.toUpperCase()
  return `${apple ? 'Meta' : 'Control'}+${key}`
}
