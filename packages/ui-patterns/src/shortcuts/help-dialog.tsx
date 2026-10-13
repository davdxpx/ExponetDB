import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogSection,
  DialogTitle,
  Label,
  Switch,
} from '@exponetdb/ui'
import { type ReactNode, useContext } from 'react'

import { ShortcutHelpContext, useActiveShortcuts } from './context.ts'
import { SHORTCUT_DEFINITIONS, SHORTCUT_GROUPS } from './definitions.ts'
import { ShortcutKeys } from './shortcut-keys.tsx'

/**
 * Lists the shortcuts that work on the current page (the ones with a handler) and
 * lets a person turn the letter shortcuts off (WCAG 2.1.4). Opened with `?`.
 */
export function ShortcutHelpDialog(): ReactNode {
  const help = useContext(ShortcutHelpContext)
  const active = useActiveShortcuts()
  if (help === null) return null

  return (
    <Dialog open={help.open} onOpenChange={help.setOpen}>
      <DialogContent
        size="medium"
        onCloseAutoFocus={(event) => {
          // The dialog has no trigger button: focus goes back to where it was when it opened.
          event.preventDefault()
          help.returnFocus.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            A shortcut with two keys is typed as one key, then the other, within a second. Shortcuts
            are off while you type in a field or while a dialog is open.
          </DialogDescription>
        </DialogHeader>
        <DialogSection className="flex flex-col gap-5">
          {SHORTCUT_GROUPS.map((group) => {
            const ids = active.filter((id) => SHORTCUT_DEFINITIONS[id].group === group)
            if (ids.length === 0) return null
            return (
              <section key={group} aria-labelledby={`shortcut-group-${group}`}>
                <h3
                  id={`shortcut-group-${group}`}
                  className="mb-2 text-xs font-medium text-foreground-lighter"
                >
                  {group}
                </h3>
                <dl className="m-0 flex flex-col gap-1.5">
                  {ids.map((id) => (
                    <div key={id} className="flex items-center justify-between gap-4 text-sm">
                      <dt className="text-foreground-light">{SHORTCUT_DEFINITIONS[id].label}</dt>
                      <dd className="m-0">
                        <ShortcutKeys shortcut={id} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )
          })}
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="shortcut-character-keys">Letter shortcuts</Label>
              <p id="shortcut-character-keys-hint" className="text-xs text-foreground-lighter">
                Turn off the shortcuts that start with a letter, such as G then P. Shortcuts with
                Command or Control stay on.
              </p>
            </div>
            <Switch
              id="shortcut-character-keys"
              aria-describedby="shortcut-character-keys-hint"
              checked={help.characterShortcuts}
              onCheckedChange={help.setCharacterShortcuts}
            />
          </div>
        </DialogSection>
      </DialogContent>
    </Dialog>
  )
}
