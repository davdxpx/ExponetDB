import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Button,
  cn,
} from '@exponetdb/ui'
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useId,
  useRef,
  useState,
} from 'react'

/**
 * The shared machinery of the confirmation ladder (design-system.md §3):
 * every dialog of `confirmations/` is an `AlertDialog` whose action
 *
 * - runs once: a second press while the first is pending does nothing, even
 *   when both arrive before React renders again (a synchronous guard);
 * - stays pending while the promise the caller returns is open: the action
 *   keeps keyboard focus (`aria-disabled`), Escape and Cancel do nothing, a
 *   click outside never dismisses an alert dialog;
 * - closes the dialog when that promise resolves and keeps it open with the
 *   error when it rejects;
 * - is unavailable (`aria-disabled`, with the reason as its description and
 *   on screen) until the gate of the dialog (a checklist, a typed text) is
 *   met.
 *
 * Internal to the package: the public components are `ConfirmDialog`,
 * `WarningConfirmDialog`, `TypedConfirmDialog` and `PlanConfirmDialog`.
 */

/** Authorization tier (C-24), as the contracts name it. */
export type PlanTier = 'prod' | 'nonprod'

/**
 * Whether a confirmation shows the production cue. A dialog without a tier
 * (an action outside any target) shows none; a dialog with a tier fails
 * closed: anything that is not exactly `nonprod` is production. A plan always
 * has a tier, so `PlanConfirmDialog` never passes `undefined` (it normalizes
 * a missing one to production).
 */
export function showsProductionCue(tier: PlanTier | undefined): boolean {
  return tier !== undefined && tier !== 'nonprod'
}

/**
 * The least destructive alternative, offered in the same dialog before the
 * main action ("Cancel the query" before "Terminate the session"). It is not
 * gated by the checklist or the typed text, so offer only an action that is
 * less destructive than the main one.
 */
export interface ConfirmAlternative {
  readonly label: string
  /** Same promise rules as `onConfirm`. */
  readonly onSelect: () => unknown
}

/** What the dialog shows when the action fails: a stable code and catalog text. */
export interface ActionFailure {
  readonly code: string
  readonly message: string
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/

/**
 * The failure to show for a rejection: an error with a stable code and a
 * message (the Web App's API errors carry catalog text) is shown as it is;
 * anything else gets fixed text, never an exception message.
 */
export function actionFailureOf(error: unknown): ActionFailure {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const { code, message } = error
    if (typeof code === 'string' && ERROR_CODE.test(code) && typeof message === 'string') {
      if (message.trim().length > 0) return { code, message }
    }
  }
  return {
    code: 'UNKNOWN',
    message: 'The request did not complete. Check the current state before you try again.',
  }
}

/** Props every dialog of the ladder takes. */
export interface ConfirmDialogBaseProps {
  /** Controlled open state; leave out with `trigger` or `defaultOpen` for an uncontrolled dialog. */
  readonly open?: boolean
  readonly defaultOpen?: boolean
  readonly onOpenChange?: (open: boolean) => void
  /** An element that opens the dialog; focus returns to it when the dialog closes. */
  readonly trigger?: ReactElement
  /** Plain text. */
  readonly title: string
  /** What happens when the person confirms, and what does not. */
  readonly description: ReactNode
  /** Names the outcome ("Drop table", "Apply to production"), never "OK" or "Submit". */
  readonly actionLabel: string
  /** Defaults to "Cancel", or "Close" when an alternative is offered. */
  readonly cancelLabel?: string
  /** The action destroys something: it uses the danger style. Leave it out otherwise. */
  readonly destructive?: boolean
  readonly alternative?: ConfirmAlternative
  /** The tier the change applies to: production gets the reserved production frame and cue. */
  readonly tier?: PlanTier
}

type ContentSize = 'small' | 'medium' | 'large'

/** The dialog root, the optional trigger and the content; the body renders inside the content. */
export function ConfirmRoot({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  size,
  children,
}: Pick<ConfirmDialogBaseProps, 'open' | 'defaultOpen' | 'onOpenChange' | 'trigger'> & {
  readonly size: ContentSize
  readonly children: ReactNode
}): ReactNode {
  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <AlertDialog open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger === undefined ? null : <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent
        ref={contentRef}
        size={size}
        onOpenAutoFocus={(event) => {
          // A typed confirmation starts in its field; every other dialog on Cancel
          // (the alert dialog's own default, the least destructive control).
          const target = contentRef.current?.querySelector('[data-confirm-initial-focus]')
          if (target instanceof HTMLElement) {
            event.preventDefault()
            target.focus()
          }
        }}
      >
        {children}
      </AlertDialogContent>
    </AlertDialog>
  )
}

export type PendingAction = 'confirm' | 'alternative'

export interface ConfirmActionState {
  readonly pending: PendingAction | null
  /** An action succeeded: nothing runs again until the dialog is opened anew. */
  readonly done: boolean
  /** Pending or done: the actions and the inputs of the dialog are locked. */
  readonly locked: boolean
  readonly failure: ActionFailure | null
  /**
   * Runs `run` once for a press. Returns the promise the alert dialog waits
   * for, or nothing (and cancels the press) while another action is pending.
   */
  readonly start: (
    which: PendingAction,
    event: MouseEvent<HTMLButtonElement>,
    run: () => unknown,
  ) => Promise<void> | undefined
  readonly fail: (error: unknown) => void
}

/**
 * Pending and failure state of a dialog's actions, with a synchronous
 * double-press guard. One success per opening: after an action resolved the
 * guard stays closed, so an owner that keeps the dialog open cannot have it
 * run twice. The state lives inside the dialog content and starts over when
 * the dialog opens again.
 */
export function useConfirmAction(): ConfirmActionState {
  const inFlight = useRef(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [done, setDone] = useState(false)
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  const start = (
    which: PendingAction,
    event: MouseEvent<HTMLButtonElement>,
    run: () => unknown,
  ): Promise<void> | undefined => {
    if (inFlight.current) {
      // Prevented: the alert dialog neither closes nor starts anything.
      event.preventDefault()
      return undefined
    }
    inFlight.current = true
    setPending(which)
    setFailure(null)
    let result: unknown
    try {
      result = run()
    } catch (error) {
      result = Promise.reject(error)
    }
    return Promise.resolve(result).then(
      () => {
        // The guard stays closed: one success per opening.
        setDone(true)
        setPending(null)
      },
      (error: unknown) => {
        inFlight.current = false
        setPending(null)
        throw error
      },
    )
  }

  return {
    pending,
    done,
    locked: pending !== null || done,
    failure,
    start,
    fail: (error) => setFailure(actionFailureOf(error)),
  }
}

/**
 * State that starts over whenever `key` changes, in the same render (no frame
 * shows the old state with the new key). Used for the typed text and the
 * checklist, keyed by what the person confirms.
 */
export function useKeyedState<T>(
  key: string,
  initial: () => T,
): readonly [T, (update: (previous: T) => T) => void] {
  const [state, setState] = useState(() => ({ key, value: initial() }))
  let current = state
  if (state.key !== key) {
    current = { key, value: initial() }
    setState(current)
  }
  const update = (fn: (previous: T) => T) =>
    // An update from a handler of an earlier key is dropped.
    setState((previous) => (previous.key === key ? { key, value: fn(previous.value) } : previous))
  return [current.value, update] as const
}

/** Whether the action may run, and why not. */
export interface ConfirmGate {
  readonly ready: boolean
  /** Shown and used as the action's description while not ready. */
  readonly reason: string
  /** The person pressed the unavailable action. */
  readonly onBlockedAttempt?: () => void
}

const READY: ConfirmGate = { ready: true, reason: '' }

export interface ConfirmLayoutProps
  extends Omit<ConfirmDialogBaseProps, 'open' | 'defaultOpen' | 'onOpenChange' | 'trigger'> {
  readonly action: ConfirmActionState
  readonly onConfirm: () => unknown
  readonly gate?: ConfirmGate
  readonly actionRef?: Ref<HTMLButtonElement>
  readonly children?: ReactNode
}

/** Header (title, production cue, description), body, failure, footer with the actions. */
export function ConfirmLayout({
  title,
  description,
  actionLabel,
  cancelLabel,
  destructive = false,
  alternative,
  tier,
  action,
  onConfirm,
  gate = READY,
  actionRef,
  children,
}: ConfirmLayoutProps): ReactNode {
  const reasonId = useId()
  const production = showsProductionCue(tier)
  const busy = action.locked
  const variant = destructive ? 'danger' : 'primary'

  const onAction = (event: MouseEvent<HTMLButtonElement>) => {
    if (!gate.ready) {
      event.preventDefault()
      return undefined
    }
    return action.start('confirm', event, onConfirm)
  }
  const blockedClick = () => {
    if (!gate.ready && !busy) gate.onBlockedAttempt?.()
  }
  const blockedKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') blockedClick()
  }

  return (
    <div
      data-slot="confirm-frame"
      data-tier={tier}
      className={cn(
        'flex flex-col',
        production && 'ring-2 ring-production ring-inset sm:rounded-lg',
      )}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        {/* The production cue is part of the dialog's description, so it is announced
            with the dialog even when focus starts in the typed field. */}
        <AlertDialogDescription asChild>
          <div className="flex flex-col gap-3">
            {production ? (
              <p className="flex flex-wrap items-center gap-2 text-foreground">
                <span className="rounded-full bg-production px-2 py-0.5 text-xs font-medium text-production-foreground">
                  Production
                </span>{' '}
                <span>This changes a production target.</span>
              </p>
            ) : null}
            <div>{description}</div>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogBody className="flex flex-col gap-4 px-5 pb-4">
        {children}
        {gate.ready ? null : (
          <p id={reasonId} className="text-sm text-foreground-light">
            {gate.reason}
          </p>
        )}
        {action.failure === null ? null : (
          <Alert variant="destructive">
            <AlertTitle>The request failed</AlertTitle>
            <AlertDescription>
              {/* Catalog text or fixed text, rendered as text. */}
              <p>{action.failure.message}</p>
              <p>
                Error code <code className="font-mono">{action.failure.code}</code>
              </p>
            </AlertDescription>
          </Alert>
        )}
        <p role="status" className="sr-only">
          {action.pending !== null ? 'In progress.' : action.done ? 'Done.' : ''}
        </p>
      </AlertDialogBody>
      <AlertDialogFooter>
        <AlertDialogCancel>
          {cancelLabel ?? (alternative === undefined ? 'Cancel' : 'Close')}
        </AlertDialogCancel>
        {alternative === undefined ? null : (
          <AlertDialogAction
            asChild
            variant="default"
            onClick={(event) => action.start('alternative', event, alternative.onSelect)}
            onActionError={action.fail}
          >
            <Button
              variant="default"
              focusableWhenDisabled
              disabled={busy}
              loading={action.pending === 'alternative'}
            >
              {alternative.label}
            </Button>
          </AlertDialogAction>
        )}
        <AlertDialogAction
          asChild
          variant={variant}
          disabled={!gate.ready}
          onClick={onAction}
          onActionError={action.fail}
        >
          <Button
            ref={actionRef}
            variant={variant}
            focusableWhenDisabled
            disabled={!gate.ready || busy}
            loading={action.pending === 'confirm'}
            aria-describedby={gate.ready ? undefined : reasonId}
            onClickCapture={blockedClick}
            onKeyDownCapture={blockedKey}
          >
            {actionLabel}
          </Button>
        </AlertDialogAction>
      </AlertDialogFooter>
    </div>
  )
}
