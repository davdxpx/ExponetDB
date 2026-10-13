import type { ReactNode } from 'react'

import {
  type ConfirmDialogBaseProps,
  ConfirmLayout,
  ConfirmRoot,
  useConfirmAction,
} from './confirm-shell.tsx'

export interface ConfirmDialogProps extends ConfirmDialogBaseProps {
  /**
   * Runs the action. Return a promise to keep the dialog open and pending until
   * it settles: the dialog closes when it resolves and shows the error when it
   * rejects. It never runs twice while pending, and after it succeeded not
   * again until the dialog opens anew.
   */
  readonly onConfirm: () => unknown
  /** More content between the description and the actions. */
  readonly children?: ReactNode
}

/**
 * The first step of the confirmation ladder: a plain confirmation for a
 * reversible action. For anything a person cannot take back use
 * `WarningConfirmDialog`, `TypedConfirmDialog` or `PlanConfirmDialog`.
 */
export function ConfirmDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  ...props
}: ConfirmDialogProps): ReactNode {
  return (
    <ConfirmRoot
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      trigger={trigger}
      size="small"
    >
      <ConfirmBody {...props} />
    </ConfirmRoot>
  )
}

function ConfirmBody({
  onConfirm,
  children,
  ...layout
}: Omit<ConfirmDialogProps, 'open' | 'defaultOpen' | 'onOpenChange' | 'trigger'>): ReactNode {
  const action = useConfirmAction()
  return (
    <ConfirmLayout {...layout} action={action} onConfirm={onConfirm}>
      {children}
    </ConfirmLayout>
  )
}
