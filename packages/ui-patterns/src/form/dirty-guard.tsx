import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@exponetdb/ui'
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

/**
 * Dirty-state guard of a form: leaving a form with unsaved changes asks first, in an in-app
 * dialog ("Discard changes?"), never a native browser dialog (design-system.md section 3).
 *
 * Contract with the app's router (the router itself is not imported here):
 *
 * 1. Call `useDirtyGuard({ when: form.formState.isDirty })` in the form's component and render
 *    `guard.dialog` anywhere in its tree.
 * 2. Wire the router's navigation blocker to `guard.requestLeave`. A blocker hands over a
 *    function that lets the navigation go on (`proceed`) and one that cancels it (`reset`); in
 *    the app's own words, for any router with such a blocker:
 *
 *    ```ts
 *    // illustrative: the app owns the router and its blocker API
 *    useEffect(() => {
 *      if (blocker.status === 'blocked') guard.requestLeave(blocker.proceed, blocker.reset)
 *    }, [blocker.status, guard.requestLeave])
 *    ```
 *
 *    `requestLeave(proceed, onStay?)` calls `proceed` at once when the form is clean. When it is
 *    dirty it opens the dialog and calls `proceed` only if the person chooses "Discard changes";
 *    "Keep editing" (or Escape) calls `onStay` and leaves the form as it is.
 * 3. The same call guards in-page exits, such as a Cancel button or a closing sheet:
 *    `onClick={() => guard.requestLeave(close)}`.
 * 4. Reloading, closing the tab and leaving the site cannot be intercepted by a dialog: while the
 *    form is dirty the hook registers a `beforeunload` listener, and the browser shows its own
 *    prompt. The listener exists only while `when` is true.
 *
 * The dialog does not decide whether the form is dirty; the form does (`when`).
 */
export interface DirtyGuardOptions {
  /** Whether leaving now would lose changes (`formState.isDirty`). */
  readonly when: boolean
}

export interface DirtyGuard {
  /** Whether the form has unsaved changes right now. */
  readonly when: boolean
  /** Whether a leave waits for the person's decision (the dialog is open). */
  readonly pending: boolean
  /**
   * Leave, or ask first. Clean form: `proceed` runs at once. Dirty form: the dialog opens and
   * `proceed` runs only after "Discard changes"; "Keep editing" runs `onStay` instead. Its
   * identity changes with `when`, so a blocker effect never calls a stale one.
   */
  readonly requestLeave: (proceed: () => void, onStay?: () => void) => void
  /** The dialog; render it once in the form's tree. */
  readonly dialog: ReactNode
}

interface PendingLeave {
  readonly proceed: () => void
  readonly onStay: (() => void) | undefined
}

export interface DirtyGuardDialogProps {
  open: boolean
  /** "Keep editing", Escape, and any other dismissal. */
  onKeepEditing: () => void
  /** "Discard changes". */
  onDiscard: () => void
  /**
   * The element that had focus when the dialog was asked for. A dialog opened by code has no
   * trigger to give focus back to, so the caller names where it goes when the person keeps editing.
   */
  returnFocusRef?: RefObject<HTMLElement | null>
}

/**
 * The confirmation shown when a dirty form is left. The least destructive answer ("Keep editing")
 * is the one that has focus when the dialog opens; the destructive one is named for what it does.
 */
export function DirtyGuardDialog({
  open,
  onKeepEditing,
  onDiscard,
  returnFocusRef,
}: DirtyGuardDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing()
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current
          if (target?.isConnected) {
            event.preventDefault()
            target.focus()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have changes that are not saved. If you leave now, they are lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="danger" onClick={onDiscard}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  // The browser shows its own generic prompt; a custom message is ignored by every browser.
  event.preventDefault()
  event.returnValue = ''
}

export function useDirtyGuard({ when }: DirtyGuardOptions): DirtyGuard {
  const [open, setOpen] = useState(false)
  // What waits for the decision. A ref, not state: the callbacks run once per decision, and a
  // state updater must stay pure (React may run it twice).
  const waiting = useRef<PendingLeave | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!when) return
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [when])

  const settle = useCallback((outcome: 'proceed' | 'stay') => {
    const leave = waiting.current
    waiting.current = null
    setOpen(false)
    if (leave === null) return
    if (outcome === 'proceed') leave.proceed()
    else leave.onStay?.()
  }, [])

  // The form became clean while a leave was waiting (a save finished): there is nothing to lose.
  useEffect(() => {
    if (!when && waiting.current !== null) settle('proceed')
  }, [when, settle])

  const requestLeave = useCallback(
    (proceed: () => void, onStay?: () => void) => {
      if (!when) {
        proceed()
        return
      }
      waiting.current = { proceed, onStay }
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setOpen(true)
    },
    [when],
  )

  const keepEditing = useCallback(() => settle('stay'), [settle])
  const discard = useCallback(() => settle('proceed'), [settle])

  const dialog = useMemo(
    () => (
      <DirtyGuardDialog
        open={open}
        onKeepEditing={keepEditing}
        onDiscard={discard}
        returnFocusRef={opener}
      />
    ),
    [open, keepEditing, discard],
  )

  return useMemo(
    () => ({ when, pending: open, requestLeave, dialog }),
    [when, open, requestLeave, dialog],
  )
}
