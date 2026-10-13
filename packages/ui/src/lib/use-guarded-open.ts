import * as React from 'react'

/**
 * Open state for overlays that the user can dismiss (dialogs and sheets).
 *
 * Every close the user asks for (Escape, a click outside, the close button, a
 * close control inside the overlay) passes through `onRequestClose` first. A
 * handler that returns `false` keeps the overlay open: the typical use is a
 * form with unsaved changes, where the handler opens an in-app confirmation
 * (never `window.confirm`) and closes the overlay later through `open`.
 *
 * - Opening is never intercepted.
 * - A close that the owner sets through the `open` prop is never intercepted;
 *   only the user's requests are.
 * - Works the same controlled (`open`) and uncontrolled (`defaultOpen`).
 */
export interface GuardedOpenOptions {
  open?: boolean | undefined
  defaultOpen?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
  /** Return `false` to keep the overlay open. Any other result lets the close happen. */
  onRequestClose?: (() => boolean | undefined) | undefined
}

export function useGuardedOpen({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  onRequestClose,
}: GuardedOpenOptions): readonly [boolean, (open: boolean) => void] {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const callbacks = React.useRef({ onOpenChange, onRequestClose })

  React.useEffect(() => {
    callbacks.current = { onOpenChange, onRequestClose }
  }, [onOpenChange, onRequestClose])

  const controlled = openProp !== undefined
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next && callbacks.current.onRequestClose?.() === false) return
      if (!controlled) setUncontrolledOpen(next)
      callbacks.current.onOpenChange?.(next)
    },
    [controlled],
  )

  return [openProp ?? uncontrolledOpen, handleOpenChange]
}
