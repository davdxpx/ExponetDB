import { AlertTriangle, Check, CircleHelp, type LucideIcon, ShieldAlert } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import { type HeadingLevel, type NowInput, useResolvedNow } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

import { knownText } from './format.ts'
import { PlanBlock } from './plan-frame.tsx'
import {
  type FactItem,
  Facts,
  FullCode,
  INLINE_ICON,
  keyedBy,
  Marked,
  Note,
  NotKnown,
  TimeText,
  Words,
} from './shared.tsx'

/** The evidence for one migration (`MigrationPlanAnalysis.evidence[]`). */
export interface EvidenceItemView {
  readonly migrationId: string
  /** `present`, `missing`, `unverified`, `other_verify_digest`, `unreachable`. */
  readonly status: string | null
  /** When the evidence environment verified it. */
  readonly verifiedAt: string | null
}

/** The break-glass grant a plan was made under (`MigrationPlanContent.breakGlass`). */
export interface BreakGlassView {
  readonly grantId: string
  /** The rules the grant overrides. */
  readonly rules: readonly string[]
}

/** The newest backup of the target. Wave 9 brings backups; until then the page passes `null`. */
export interface NewestBackupView {
  /** When the backup finished. */
  readonly at: string | null
  /** The backup was verified by a restore test; `null` when not known. */
  readonly verified: boolean | null
}

export interface PlanEvidenceBlockProps {
  /**
   * `change.content.facts.evidence` of a migration plan: `present`, `missing`,
   * `unverified`, `other_verify_digest`, `unreachable`, `not_required`.
   */
  readonly evidence: string | null
  /** The evidence environment, when the page has it (`<product>/<project>/<environment>`). */
  readonly evidenceEnvironment?: string | null
  /** Per migration (`change.analysis.evidence`). */
  readonly items?: readonly EvidenceItemView[] | null
  /** Present when the plan was made under a break-glass grant. */
  readonly breakGlass?: BreakGlassView | null
  /** `change.content.expectedState.schemaFingerprint`: the schema state the plan binds. */
  readonly schemaFingerprint: string | null
  /** `null` until Wave 9: shown as "not known". */
  readonly newestBackup: NewestBackupView | null
  readonly now?: NowInput
  readonly headingLevel?: HeadingLevel
}

interface EvidenceText {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: 'met' | 'warning' | 'neutral'
}

const EVIDENCE: Readonly<Record<string, EvidenceText>> = {
  present: {
    label: 'Applied and verified with the same checksum on the evidence environment',
    icon: Check,
    tone: 'met',
  },
  missing: {
    label: 'Missing: not applied and verified with the same checksum on the evidence environment',
    icon: AlertTriangle,
    tone: 'warning',
  },
  unverified: {
    label: 'Applied on the evidence environment, but not verified there',
    icon: AlertTriangle,
    tone: 'warning',
  },
  other_verify_digest: {
    label: 'Verified on the evidence environment with a different verify.sql',
    icon: AlertTriangle,
    tone: 'warning',
  },
  unreachable: {
    label: 'The evidence environment could not be read',
    icon: AlertTriangle,
    tone: 'warning',
  },
  not_required: {
    label: 'Not required for this target',
    icon: CircleHelp,
    tone: 'neutral',
  },
}

function EvidenceValue({ status }: { readonly status: string | null }): ReactNode {
  const known = knownText(status)
  if (known === undefined) return <NotKnown />
  const text = Object.hasOwn(EVIDENCE, known) ? EVIDENCE[known] : undefined
  if (text === undefined) {
    return (
      <Words>
        <CircleHelp aria-hidden="true" className={INLINE_ICON} />
        <Marked text={known} mono />
        <span className="text-foreground-light">(not a known evidence state)</span>
      </Words>
    )
  }
  const Icon = text.icon
  return (
    <span
      data-evidence={known}
      className={cn(text.tone === 'warning' && 'font-medium text-warning-600')}
    >
      <Icon aria-hidden="true" className={cn(INLINE_ICON, 'mr-1.5')} />
      {text.label}
    </span>
  )
}

function BackupValue({
  backup,
  now,
}: {
  readonly backup: NewestBackupView | null
  readonly now: number
}): ReactNode {
  if (backup === null) return <NotKnown />
  return (
    <Words>
      <TimeText at={backup.at} now={now} />
      <span className="text-foreground-light">
        {backup.verified === null
          ? '(restore test not known)'
          : backup.verified
            ? '(verified by a restore test)'
            : '(not verified by a restore test)'}
      </span>
    </Words>
  )
}

/**
 * The evidence the plan rests on: the staging evidence (the same checksum
 * applied and verified on the evidence environment, missing, or a
 * break-glass grant instead), the schema fingerprint the plan binds and the
 * newest backup ("not known" until Wave 9).
 */
export function PlanEvidenceBlock({
  evidence,
  evidenceEnvironment,
  items,
  breakGlass,
  schemaFingerprint,
  newestBackup,
  now,
  headingLevel,
}: PlanEvidenceBlockProps): ReactNode {
  const current = useResolvedNow(now)
  const facts: FactItem[] = [
    { id: 'evidence', label: 'Staging evidence', value: <EvidenceValue status={evidence} /> },
  ]
  if (evidenceEnvironment !== undefined) {
    facts.push({
      id: 'evidence-environment',
      label: 'Evidence environment',
      value: evidenceEnvironment === null ? <NotKnown /> : <FullCode text={evidenceEnvironment} />,
    })
  }
  facts.push(
    {
      id: 'schema-fingerprint',
      label: 'Schema state',
      value:
        schemaFingerprint === null || knownText(schemaFingerprint) === undefined ? (
          <NotKnown />
        ) : (
          <span className="flex min-w-0 flex-col items-start gap-1">
            <span>
              bound to fingerprint <FullCode text={schemaFingerprint} />
            </span>
            <span className="text-foreground-light">
              Any schema change before the apply makes the plan stale.
            </span>
          </span>
        ),
    },
    {
      id: 'newest-backup',
      label: 'Newest backup',
      value: <BackupValue backup={newestBackup} now={current} />,
    },
  )

  return (
    <PlanBlock title="Evidence" headingLevel={headingLevel} data-plan-block="evidence">
      {breakGlass === undefined || breakGlass === null ? null : (
        <Note tone="warning">
          <Words>
            <ShieldAlert aria-hidden="true" className={cn(INLINE_ICON, 'text-warning-600')} />
            <strong className="font-medium">Made under break-glass.</strong>
            <span>Grant</span>
            <Marked text={breakGlass.grantId} mono />
            <span>overrides</span>
            {breakGlass.rules.length === 0 ? (
              <span>
                rules <NotKnown />
              </span>
            ) : (
              keyedBy(breakGlass.rules, (rule) => rule).map(({ item: rule, key }, index) => (
                <Marked
                  key={key}
                  text={index < breakGlass.rules.length - 1 ? `${rule},` : rule}
                  mono
                />
              ))
            )}
          </Words>
        </Note>
      )}
      <Facts items={facts} />
      {items === undefined || items === null || items.length === 0 ? null : (
        <ul aria-label="Evidence per migration" className="flex flex-col gap-1 text-sm">
          {keyedBy(items, (item) => item.migrationId).map(({ item, key }) => (
            <li key={key} data-evidence-item={item.migrationId} className="min-w-0">
              <Words>
                <Marked text={item.migrationId} mono />
                <EvidenceValue status={item.status} />
                {item.verifiedAt === null ? null : (
                  <span className="text-foreground-light">
                    verified <TimeText at={item.verifiedAt} now={current} />
                  </span>
                )}
              </Words>
            </li>
          ))}
        </ul>
      )}
    </PlanBlock>
  )
}
