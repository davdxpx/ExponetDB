import { Button } from '@exponetdb/ui'
import { ConfirmDialog, MarkedCode, TierChip, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { actionError } from '../plans/failure.ts'
import { isTargetPath } from '../target/params.ts'
import {
  type EvidenceState,
  evidenceWarns,
  isMigrationId,
  PLAN_MIGRATION_CAP,
} from './bundle-model.ts'

/** The evidence of one bundle in words: a short sentence a person reads before planning. */
export function evidenceText(evidence: EvidenceState, destination: string): string | undefined {
  switch (evidence.kind) {
    case 'not_required':
      return undefined
    case 'no_environment':
      return t('promote.evidence.noEnvironment', { destination })
    case 'verified':
      return t('promote.evidence.verified', { from: evidence.from })
    case 'other_checksum':
      return t('promote.evidence.otherChecksum', { from: evidence.from, destination })
    case 'not_verified':
      return t('promote.evidence.notVerified', { from: evidence.from, destination })
    case 'not_known':
      return evidence.from === null
        ? t('promote.evidence.notKnownAnywhere', { destination })
        : t('promote.evidence.notKnown', { from: evidence.from, destination })
  }
}

/**
 * The evidence of one bundle for a production-tier destination, from the
 * Control Store mirror. A warning is a word and a sentence, never a color
 * alone; a non-production destination shows nothing (the rule does not apply).
 */
export function EvidenceNote({
  evidence,
  destination,
}: {
  readonly evidence: EvidenceState
  readonly destination: string
}): ReactNode {
  const text = evidenceText(evidence, destination)
  if (text === undefined) return null
  return (
    <span
      data-evidence={evidence.kind}
      className={evidenceWarns(evidence) ? 'text-warning-600' : 'text-foreground-light'}
    >
      {text}
    </span>
  )
}

/** One bundle the action plans: its id, its untrusted name and its evidence for the destination. */
export interface PlannedBundle {
  readonly migrationId: string
  readonly name: string
  readonly evidence: EvidenceState
}

export interface PlanBundlesActionProps {
  /** The destination target's path (`<product>/<project>/<environment>`). */
  readonly targetPath: string
  /** The destination environment's slug, named on the button ("Plan on production"). */
  readonly environment: string
  /** The destination's tier: anything but exactly `nonprod` gets the production cue. */
  readonly tier: string | null | undefined
  /** The bundles to plan; the server orders them by `dependsOn`. */
  readonly bundles: readonly PlannedBundle[]
}

/**
 * "Plan on <environment>": plans stored bundles by id on a target
 * (`POST /targets/{t}/migrations/plans` with `migrationIds`), through the
 * existing plan action (re-authentication when the server asks for it, then
 * the plan review page). Before it sends, the dialog names the target, the
 * bundles and, for a production-tier destination, what the evidence
 * environment's mirror says about each: a bundle that is not verified there
 * is still offered, because the server decides and explains its refusal on
 * the plan. Nothing runs here: the plan is reviewed, approved and applied on
 * its own page.
 */
export function PlanBundlesAction({
  targetPath,
  environment,
  tier,
  bundles,
}: PlanBundlesActionProps): ReactNode {
  const { client } = useApi()
  const createPlan = usePlanAction()
  const hintId = useId()
  const production = tier !== 'nonprod'
  const valid = bundles.filter((bundle) => isMigrationId(bundle.migrationId))
  const tooMany = valid.length > PLAN_MIGRATION_CAP
  const unavailable = !isTargetPath(targetPath) || valid.length === 0 || tooMany
  const warnings = valid.filter((bundle) => evidenceWarns(bundle.evidence)).length
  const label = t('promote.plan.button', { environment })

  const plan = async (): Promise<void> => {
    try {
      await createPlan(() =>
        client.operation('planMigrations', {
          params: { target: targetPath },
          body: { migrationIds: valid.map((bundle) => bundle.migrationId) },
        }),
      )
    } catch (error) {
      throw actionError(error)
    }
  }

  const hint = tooMany
    ? t('promote.plan.tooMany', { max: PLAN_MIGRATION_CAP })
    : valid.length === 0
      ? t('promote.plan.none')
      : t('promote.plan.count', { count: valid.length })

  return (
    <div className="flex flex-wrap items-center gap-2" data-plan-action={environment}>
      <ConfirmDialog
        trigger={
          <Button
            variant="primary"
            size="small"
            disabled={unavailable}
            focusableWhenDisabled
            aria-describedby={hintId}
          >
            {label}
          </Button>
        }
        title={t('promote.plan.title', { environment })}
        description={
          <span className="flex flex-col gap-2">
            <span>{t('promote.plan.description', { count: valid.length })}</span>
            <MarkedCode text={targetPath} />
          </span>
        }
        actionLabel={t('promote.plan.action')}
        tier={production ? 'prod' : 'nonprod'}
        onConfirm={plan}
      >
        <div className="flex flex-col gap-2 py-2 text-sm">
          {production && warnings > 0 ? (
            <p data-evidence-summary className="m-0 font-medium">
              {t('promote.plan.warnings', { count: warnings, environment })}
            </p>
          ) : null}
          <ul className="m-0 flex max-h-64 list-none flex-col gap-2 overflow-auto p-0">
            {valid.map((bundle) => (
              <li key={bundle.migrationId} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <UntrustedName name={bundle.name} label={t('promote.column.bundle')} />
                  <span className="font-mono text-xs text-foreground-lighter">
                    {bundle.migrationId}
                  </span>
                </span>
                <EvidenceNote evidence={bundle.evidence} destination={environment} />
              </li>
            ))}
          </ul>
          <p className="m-0 text-xs text-foreground-light">{t('promote.plan.serverDecides')}</p>
        </div>
      </ConfirmDialog>
      {production ? <TierChip tier="prod" name={environment} /> : null}
      <span id={hintId} className="text-xs text-foreground-light">
        {hint}
      </span>
    </div>
  )
}
