import { Copy } from '@exponetdb/icons'
import { Button, copyToClipboard } from '@exponetdb/ui'
import { type ReactNode, useRef, useState } from 'react'

import {
  type ConfirmDialogBaseProps,
  type ConfirmGate,
  ConfirmLayout,
  ConfirmRoot,
  isProductionTier,
  type PlanTier,
  useConfirmAction,
  useKeyedState,
} from './confirm-shell.tsx'
import { MarkedCode } from './marked-code.tsx'
import { TypedConfirmationField, useTypedConfirmation } from './typed-confirm-dialog.tsx'

/** Action classes of a stored plan (operations-engine.md §1, `ActionClass` of the contracts). */
export type PlanClass = 'low' | 'standard' | 'high' | 'critical'

const CLASS_MEANING: Readonly<Record<PlanClass, string>> = {
  low: 'A small, reversible or self-limiting effect on one object.',
  standard: 'Changes the structure, configuration or availability of one target or cluster.',
  high: 'A structural change, restart, credential rotation or session termination on production.',
  critical: 'Replaces or destroys data or identity.',
}

/** The facts of the plan the dialog shows, and that `onConfirm` receives back. */
export interface PlanConfirmFacts {
  /** `sha256:…`, shown in full. */
  readonly planHash: string
  readonly tier: PlanTier
  readonly planClass: PlanClass
  /** `<product>/<project>/<environment>`; typed for `high` and `critical`. */
  readonly targetPath: string
  /**
   * What a `critical` plan does, in one line ("replaces placement of
   * shop/platform/production"); typed for `critical` after the target path.
   * Required for `critical`: without it the plan cannot be confirmed here.
   */
  readonly effect?: string
}

export interface PlanConfirmDialogProps extends Omit<ConfirmDialogBaseProps, 'tier'> {
  readonly plan: PlanConfirmFacts
  /**
   * Receives the facts exactly as the dialog showed them when the person
   * confirmed; the app sends that plan hash. The dialog binds nothing itself.
   * Same promise rules as `ConfirmDialog`'s `onConfirm`.
   */
  readonly onConfirm: (shown: PlanConfirmFacts) => unknown
  readonly children?: ReactNode
}

/**
 * The top of the confirmation ladder: applying a plan. Shows the target path,
 * the tier (production in the reserved production frame), the plan class, the
 * full plan hash with a copy button and, for `critical`, the effect.
 * `low` and `standard` plans are confirmed with the action alone; `high` and
 * `critical` plans need the target path typed, and `critical` plans the effect
 * typed as well (information-architecture.md §5, Wave 8 order §8). The
 * typed text starts over whenever the plan hash, tier, class, target path or
 * effect changes. While the action is pending the dialog keeps showing the
 * facts that were confirmed, even if the plan changes meanwhile. A class other
 * than `low` and `standard` needs the typed path (fails closed).
 */
export function PlanConfirmDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  ...props
}: PlanConfirmDialogProps): ReactNode {
  return (
    <ConfirmRoot
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      trigger={trigger}
      size="medium"
    >
      <PlanConfirmBody {...props} />
    </ConfirmRoot>
  )
}

function factsOf(plan: PlanConfirmFacts): PlanConfirmFacts {
  return {
    planHash: plan.planHash,
    tier: plan.tier,
    planClass: plan.planClass,
    targetPath: plan.targetPath,
    ...(plan.effect === undefined ? {} : { effect: plan.effect }),
  }
}

function PlanConfirmBody({
  plan,
  onConfirm,
  children,
  ...layout
}: Omit<PlanConfirmDialogProps, 'open' | 'defaultOpen' | 'onOpenChange' | 'trigger'>): ReactNode {
  const action = useConfirmAction()
  const actionRef = useRef<HTMLButtonElement>(null)
  const [confirmed, setConfirmed] = useState<PlanConfirmFacts | null>(null)
  // While pending, the facts that were confirmed; otherwise the current ones.
  const shown = confirmed ?? factsOf(plan)
  const typedNeeded = shown.planClass !== 'low' && shown.planClass !== 'standard'
  const critical = shown.planClass === 'critical'
  const effect = shown.effect ?? ''
  const effectMissing = critical && effect.trim() === ''
  const bindingKey = JSON.stringify([shown.planHash, shown.tier, shown.planClass, effect])
  const typedPath = useTypedConfirmation(shown.targetPath, bindingKey)
  const typedEffect = useTypedConfirmation(effect, `${bindingKey}:effect`)

  const gate: ConfirmGate = effectMissing
    ? {
        ready: false,
        reason: 'This critical plan names no effect, so it cannot be confirmed here.',
      }
    : critical
      ? {
          ready: typedPath.matches && typedEffect.matches,
          reason: 'Type the target path and the effect exactly as shown to continue.',
          onBlockedAttempt: () => {
            typedPath.markTried()
            typedEffect.markTried()
          },
        }
      : typedNeeded
        ? {
            ready: typedPath.matches,
            reason: 'Type the target path exactly as shown to continue.',
            onBlockedAttempt: typedPath.markTried,
          }
        : { ready: true, reason: '' }

  const confirm = async () => {
    const facts = shown
    setConfirmed(facts)
    try {
      await onConfirm(facts)
    } finally {
      setConfirmed(null)
    }
  }

  return (
    <ConfirmLayout
      {...layout}
      tier={shown.tier}
      action={action}
      onConfirm={confirm}
      gate={gate}
      actionRef={actionRef}
    >
      {children}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-foreground-light">Target</dt>
        <dd>
          <MarkedCode text={shown.targetPath} />
        </dd>
        <dt className="text-foreground-light">Tier</dt>
        <dd className="text-foreground">
          {isProductionTier(shown.tier) ? 'Production' : 'Non-production'}
        </dd>
        <dt className="text-foreground-light">Class</dt>
        <dd className="text-foreground">
          <span className="font-mono">{shown.planClass}</span>:{' '}
          {Object.hasOwn(CLASS_MEANING, shown.planClass)
            ? CLASS_MEANING[shown.planClass]
            : 'Not a known class.'}
        </dd>
        <dt className="text-foreground-light">Plan hash</dt>
        <dd>
          <PlanHash planHash={shown.planHash} />
        </dd>
        {critical ? (
          <>
            <dt className="text-foreground-light">Effect</dt>
            <dd className="font-medium text-foreground">
              {/* UntrustedText: server text that may carry object names. */}
              {effectMissing ? 'Not named' : <MarkedCode text={effect} />}
            </dd>
          </>
        ) : null}
      </dl>
      {typedNeeded && !effectMissing ? (
        <TypedConfirmationField
          expectedText={shown.targetPath}
          expectedTextName="the target path"
          typed={typedPath}
          busy={action.locked}
          actionRef={actionRef}
        />
      ) : null}
      {critical && !effectMissing ? (
        <TypedConfirmationField
          expectedText={effect}
          expectedTextName="the effect"
          typed={typedEffect}
          busy={action.locked}
          actionRef={actionRef}
          initialFocus={false}
        />
      ) : null}
    </ConfirmLayout>
  )
}

type CopyState = 'idle' | 'copied' | 'failed'

/** The full plan hash, monospace, with a copy button and its result. */
function PlanHash({ planHash }: { readonly planHash: string }): ReactNode {
  const [copy, setCopy] = useKeyedState<CopyState>(planHash, () => 'idle')
  return (
    <div className="flex flex-col items-start gap-1">
      <MarkedCode text={planHash} className="text-xs" />
      <div className="flex items-center gap-2">
        <Button
          variant="default"
          icon={<Copy />}
          aria-label="Copy plan hash"
          onClick={async () => {
            const copied = await copyToClipboard(planHash)
            setCopy(() => (copied ? 'copied' : 'failed'))
          }}
        >
          Copy
        </Button>
        <span role="status" className="text-xs text-foreground-light">
          {copy === 'copied'
            ? 'Plan hash copied.'
            : copy === 'failed'
              ? 'Could not copy the plan hash. Select it and copy it instead.'
              : ''}
        </span>
      </div>
    </div>
  )
}
