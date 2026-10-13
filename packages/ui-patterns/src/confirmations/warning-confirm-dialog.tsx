import { Checkbox, Label } from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'

import {
  type ConfirmDialogBaseProps,
  type ConfirmGate,
  ConfirmLayout,
  ConfirmRoot,
  useConfirmAction,
  useKeyedState,
} from './confirm-shell.tsx'

export interface WarningConfirmDialogProps extends ConfirmDialogBaseProps {
  /**
   * Statements the person ticks, one labelled checkbox each; all are required.
   * Plain text, written by the caller ("No backup of this target is verified").
   */
  readonly checklist: readonly string[]
  /** The legend of the checklist. */
  readonly checklistLegend?: string
  /**
   * Changing it clears the ticks, like a changed checklist or tier does (pass
   * the id or hash of what the dialog confirms).
   */
  readonly resetKey?: string
  /** Same promise rules as `ConfirmDialog`'s `onConfirm`. */
  readonly onConfirm: () => unknown
  readonly children?: ReactNode
}

/**
 * The second step of the confirmation ladder: a warning with a checklist of
 * statements the person ticks before the action becomes available. The ticks
 * start over each time the dialog opens and whenever the checklist, the tier
 * or `resetKey` changes, so a tick never carries over to a different change.
 * An empty checklist fails closed (the action never becomes available).
 */
export function WarningConfirmDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  ...props
}: WarningConfirmDialogProps): ReactNode {
  return (
    <ConfirmRoot
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      trigger={trigger}
      size="medium"
    >
      <WarningConfirmBody {...props} />
    </ConfirmRoot>
  )
}

function WarningConfirmBody({
  checklist,
  checklistLegend = 'Confirm each statement',
  resetKey,
  onConfirm,
  children,
  ...layout
}: Omit<
  WarningConfirmDialogProps,
  'open' | 'defaultOpen' | 'onOpenChange' | 'trigger'
>): ReactNode {
  const action = useConfirmAction()
  const baseId = useId()
  const busy = action.locked
  const key = JSON.stringify([checklist, layout.tier ?? null, resetKey ?? null])
  const [ticked, setTicked] = useKeyedState<readonly boolean[]>(key, () => [])

  const count = checklist.filter((_, index) => ticked[index] === true).length
  const gate: ConfirmGate =
    checklist.length === 0
      ? { ready: false, reason: 'There is nothing to confirm, so this action is not available.' }
      : {
          ready: count === checklist.length,
          reason: `Tick each statement to continue (${count} of ${checklist.length} ticked).`,
        }

  return (
    <ConfirmLayout {...layout} action={action} onConfirm={onConfirm} gate={gate}>
      {children}
      {checklist.length === 0 ? null : (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm text-foreground">{checklistLegend}</legend>
          {checklist.map((statement, index) => {
            const id = `${baseId}-${index}`
            return (
              // The checklist is fixed for one key; its position is its identity.
              <div key={id} className="flex items-start gap-2">
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={ticked[index] === true}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setTicked((previous) => {
                      const next = checklist.map((_, i) => previous[i] === true)
                      next[index] = checked === true
                      return next
                    })
                  }
                />
                <Label htmlFor={id} className="leading-snug text-foreground">
                  {statement}
                </Label>
              </div>
            )
          })}
        </fieldset>
      )}
    </ConfirmLayout>
  )
}
