import { CircleHelp, Trash2 } from '@exponetdb/icons'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  ClassificationBadge,
  formatCount,
  type HeadingLevel,
  type StatementClassification,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId } from 'react'

import { knownNumber, knownText } from './format.ts'
import { PlanBlock } from './plan-frame.tsx'
import {
  type FactItem,
  Facts,
  FullCode,
  INLINE_ICON,
  keyedBy,
  Marked,
  NotKnown,
  Words,
} from './shared.tsx'

/** The lock a statement takes: its mode and severity, `none` when the server derived none, `null` when not known. */
export type StatementLock =
  | { readonly mode: string; readonly severity?: string | null }
  | 'none'
  | null

/** One statement as the server analyzed it (`MigrationAnalysis.statements[]`). */
export interface StatementAnalysisView {
  /** 0-based position in the file (`index`); shown 1-based. */
  readonly index: number
  /** The line the statement starts on in `up.sql`. */
  readonly line: number | null
  /** The statement kind the parser named, such as `ALTER TABLE`. */
  readonly kind: string | null
  /**
   * `lock` of the analysis: `{ mode, severity }`, or `none` for `lock: null`
   * (no lock derived). The Wave 7 review model (`StatementFact.lock`) does not
   * keep `null` apart from a missing field; map its `undefined` to `null`
   * ("not known"), never to `none`.
   */
  readonly lock: StatementLock
  /** `additive`, `potentially_breaking`, `data_rewrite`, `destructive`, `unknown`. */
  readonly compatibility: string | null
  /** `none`, `table`, `possible`, `unknown`. */
  readonly rewrite?: string | null
  /** `false` for a statement that cannot run in a transaction. */
  readonly transactional?: boolean | null
  /** `derived`, `partly_derived`, `underived`: a lock of `none` counts only for `derived`. */
  readonly coverage?: string | null
}

/** An estimate of a table rewrite (`MigrationAnalysis.rewriteRisk[]`). */
export interface RewriteEstimateView {
  /** Untrusted: the relation's name. */
  readonly relation: string
  readonly rows: number | null
  readonly bytes: number | null
}

/** Rollback of one migration (`MigrationAnalysis.rollback`). */
export type RollbackView =
  | { readonly available: true; readonly declaredSafety: string | null }
  | { readonly available: false }

/** The analysis of one migration (`MigrationAnalysis` with the plan item's name and checksum). */
export interface MigrationAnalysisView {
  readonly migrationId: string
  /** Untrusted: the bundle's own name. */
  readonly name: string | null
  readonly compatibility: {
    readonly declared: string | null
    readonly observed: string | null
    /** `agreement === false`; `null` when not known. */
    readonly disagree: boolean | null
  } | null
  /** `lockSeverity`: `none`, `low`, `medium`, `high`, `critical`, `unknown`. */
  readonly lockSeverity: string | null
  readonly statements: readonly StatementAnalysisView[] | null
  /** Untrusted: the objects the migration drops (`destructive`). */
  readonly drops: readonly string[] | null
  readonly rewrites: readonly RewriteEstimateView[] | null
  readonly rollback: RollbackView | null
  /** The apply checksum (`sha256:c1:…`) the plan binds. */
  readonly checksum: string | null
}

/** The analysis of the whole plan (`MigrationPlanAnalysis.summary`). */
export interface AnalysisOverallView {
  readonly compatibility: string | null
  readonly lockSeverity: string | null
  /** The plan drops objects; `null` when not known. */
  readonly destructive: boolean | null
  /** Part of the plan does not run in one transaction; `null` when not known. */
  readonly nontransactional: boolean | null
}

export interface PlanAnalysisBlockProps {
  /** `null` when the plan carries no overall analysis or it is not known. */
  readonly overall: AnalysisOverallView | null
  /** Per migration, in plan order; `null` when not known. */
  readonly migrations: readonly MigrationAnalysisView[] | null
  readonly headingLevel?: HeadingLevel
}

const COMPATIBILITY: Readonly<Record<string, string>> = {
  additive: 'Additive',
  potentially_breaking: 'Potentially breaking',
  data_rewrite: 'Data rewrite',
  destructive: 'Destructive',
}

const LOCK_SEVERITY: Readonly<Record<string, string>> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}

const REWRITE: Readonly<Record<string, string>> = {
  none: 'None',
  table: 'Whole table',
  possible: 'Possible',
}

/** A server enum value in words; `not known` for missing and `unknown`; an unknown value by its name. */
function EnumValue({
  value,
  labels,
}: {
  readonly value: string | null | undefined
  readonly labels: Readonly<Record<string, string>>
}): ReactNode {
  const known = knownText(value)
  if (known === undefined) return <NotKnown />
  const label = Object.hasOwn(labels, known) ? labels[known] : undefined
  if (label !== undefined) return <span data-value={known}>{label}</span>
  return (
    <Words>
      <CircleHelp aria-hidden="true" className={INLINE_ICON} />
      <Marked text={known} mono />
      <span className="text-foreground-light">(not a known value)</span>
    </Words>
  )
}

function YesNo({
  value,
  yes,
  no,
}: {
  readonly value: boolean | null
  readonly yes: string
  readonly no: string
}): ReactNode {
  if (value === null) return <NotKnown />
  return <span>{value ? yes : no}</span>
}

function LockValue({
  lock,
  coverage,
}: {
  readonly lock: StatementLock
  readonly coverage: string | null | undefined
}): ReactNode {
  if (lock === null) return <NotKnown />
  if (lock === 'none') {
    // No lock derived counts as "none" only where the server derived the whole statement.
    return coverage === 'derived' ? <span>None</span> : <NotKnown>(not fully analyzed)</NotKnown>
  }
  return (
    <Words>
      {knownText(lock.mode) === undefined ? (
        <NotKnown>(mode)</NotKnown>
      ) : (
        <Marked text={lock.mode} mono />
      )}
      <span className="text-foreground-light">
        (severity <EnumValue value={lock.severity} labels={LOCK_SEVERITY} />)
      </span>
    </Words>
  )
}

/** The classes of a statement, from the server's facts only. */
function statementClasses(statement: StatementAnalysisView): StatementClassification[] {
  const classes: StatementClassification[] = []
  if (statement.compatibility === 'destructive') classes.push('destructive')
  if (statement.rewrite === 'table' || statement.rewrite === 'possible') classes.push('rewrite')
  if (statement.transactional === false) classes.push('non_transactional')
  return classes
}

/** Every fact the classes come from is known: only then does "no class" mean none. */
function classesComplete(statement: StatementAnalysisView): boolean {
  return (
    knownText(statement.compatibility) !== undefined &&
    knownText(statement.rewrite) !== undefined &&
    typeof statement.transactional === 'boolean'
  )
}

function StatementsTable({
  migrationId,
  statements,
}: {
  readonly migrationId: string
  readonly statements: readonly StatementAnalysisView[]
}): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{`Statements of ${migrationId}`}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Statement</TableHead>
          <TableHead scope="col">Line</TableHead>
          <TableHead scope="col">Kind</TableHead>
          <TableHead scope="col">Lock</TableHead>
          <TableHead scope="col">Compatibility</TableHead>
          <TableHead scope="col">Table rewrite</TableHead>
          <TableHead scope="col">Classes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keyedBy(statements, (s) => String(s.index)).map(({ item: statement, key }) => {
          const classes = statementClasses(statement)
          const destructive = statement.compatibility === 'destructive'
          return (
            <TableRow
              key={key}
              data-statement={statement.index}
              data-destructive={destructive ? '' : undefined}
              className={destructive ? 'destructive' : undefined}
            >
              <TableCell className="font-mono text-xs">{`#${statement.index + 1}`}</TableCell>
              <TableCell className="font-mono text-xs">
                {knownNumber(statement.line) === undefined ? (
                  <NotKnown />
                ) : (
                  formatCount(statement.line ?? 0)
                )}
              </TableCell>
              <TableCell>
                {knownText(statement.kind) === undefined ? (
                  <NotKnown />
                ) : (
                  <Marked text={statement.kind ?? ''} mono />
                )}
              </TableCell>
              <TableCell>
                <LockValue lock={statement.lock} coverage={statement.coverage} />
              </TableCell>
              <TableCell>
                <EnumValue value={statement.compatibility} labels={COMPATIBILITY} />
              </TableCell>
              <TableCell>
                {statement.rewrite === undefined ? (
                  <NotKnown />
                ) : (
                  <EnumValue value={statement.rewrite} labels={REWRITE} />
                )}
              </TableCell>
              <TableCell>
                {classes.length === 0 ? (
                  classesComplete(statement) ? (
                    <span className="text-foreground-lighter">None</span>
                  ) : (
                    <NotKnown />
                  )
                ) : (
                  <span className="inline-flex flex-wrap gap-1">
                    {classes.map((c) => (
                      <ClassificationBadge key={c} classification={c} />
                    ))}
                  </span>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function DropsValue({ drops }: { readonly drops: readonly string[] | null }): ReactNode {
  if (drops === null) return <NotKnown />
  if (drops.length === 0) return <span>Nothing</span>
  return (
    <ul className="flex flex-col gap-1">
      {keyedBy(drops, (drop) => drop).map(({ item: drop, key }) => (
        <li key={key} className="destructive flex min-w-0 items-baseline gap-1.5">
          <Trash2 aria-hidden="true" className="size-3 shrink-0 self-center text-destructive" />
          <UntrustedName name={drop} mono label="dropped object" />
        </li>
      ))}
    </ul>
  )
}

function RewritesValue({
  rewrites,
}: {
  readonly rewrites: readonly RewriteEstimateView[] | null
}): ReactNode {
  if (rewrites === null) return <NotKnown />
  if (rewrites.length === 0) return <span>None</span>
  return (
    <ul className="flex flex-col gap-1">
      {keyedBy(rewrites, (r) => r.relation).map(({ item: rewrite, key }) => {
        const rows = knownNumber(rewrite.rows)
        const bytes = knownNumber(rewrite.bytes)
        return (
          <li key={key} className="min-w-0">
            <UntrustedName name={rewrite.relation} mono label="relation" />{' '}
            <span className="text-foreground-light">
              {`about ${rows === undefined ? 'an unknown number of' : formatCount(rows)} rows, ${bytes === undefined ? 'size not known' : `${formatCount(bytes)} bytes`} (estimate)`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function RollbackValue({ rollback }: { readonly rollback: RollbackView | null }): ReactNode {
  if (rollback === null) return <NotKnown />
  if (!rollback.available) {
    return <span>None: a failure is not undone automatically</span>
  }
  const safety = knownText(rollback.declaredSafety)
  return (
    <Words>
      <span>down.sql exists, declared</span>
      {safety === undefined ? <span>without a safety class</span> : <Marked text={safety} mono />}
      <span className="text-foreground-light">(it never runs automatically)</span>
    </Words>
  )
}

function CompatibilityValue({
  compatibility,
}: {
  readonly compatibility: MigrationAnalysisView['compatibility']
}): ReactNode {
  if (compatibility === null) return <NotKnown />
  return (
    <Words>
      <span>declared</span>
      <span>
        <EnumValue value={compatibility.declared} labels={COMPATIBILITY} />,
      </span>
      <span>observed</span>
      <EnumValue value={compatibility.observed} labels={COMPATIBILITY} />
      {compatibility.disagree === true ? (
        <strong className="font-medium text-warning-600">(they disagree)</strong>
      ) : compatibility.disagree === null ? (
        <span className="text-foreground-light">(agreement not known)</span>
      ) : null}
    </Words>
  )
}

function MigrationSection({
  migration,
  headingLevel,
}: {
  readonly migration: MigrationAnalysisView
  readonly headingLevel: HeadingLevel
}): ReactNode {
  const headingId = useId()
  const Heading = `h${headingLevel}` as const
  const items: FactItem[] = [
    {
      id: 'compatibility',
      label: 'Compatibility',
      value: <CompatibilityValue compatibility={migration.compatibility} />,
    },
    {
      id: 'lock',
      label: 'Strongest lock',
      value: <EnumValue value={migration.lockSeverity} labels={LOCK_SEVERITY} />,
    },
    { id: 'drops', label: 'Drops', value: <DropsValue drops={migration.drops} /> },
    {
      id: 'rewrites',
      label: 'Table rewrites (estimate)',
      value: <RewritesValue rewrites={migration.rewrites} />,
    },
    { id: 'rollback', label: 'Rollback', value: <RollbackValue rollback={migration.rollback} /> },
    {
      id: 'checksum',
      label: 'Checksum',
      value: migration.checksum === null ? <NotKnown /> : <FullCode text={migration.checksum} />,
    },
  ]
  return (
    <section
      aria-labelledby={headingId}
      data-migration={migration.migrationId}
      className="flex min-w-0 flex-col gap-3 border-t border-default pt-3"
    >
      <Heading id={headingId} className="min-w-0 text-sm font-medium">
        <Words>
          {migration.name === null ? (
            <span>
              Name <NotKnown />
            </span>
          ) : (
            <UntrustedName name={migration.name} label="migration name" />
          )}
          <Marked text={migration.migrationId} mono className="text-foreground-light" />
        </Words>
      </Heading>
      <Facts items={items} />
      {migration.statements === null ? (
        <p className="text-sm">
          The statements of this migration are <NotKnown />.
        </p>
      ) : migration.statements.length === 0 ? (
        <p className="text-sm text-foreground-light">The analysis lists no statements.</p>
      ) : (
        <StatementsTable migrationId={migration.migrationId} statements={migration.statements} />
      )}
    </section>
  )
}

/**
 * What ExponetDB's analysis found, per migration: compatibility (declared and
 * observed), the strongest lock, every statement with its line, kind, lock,
 * compatibility and rewrite, the classification badges, the objects it drops,
 * the rewrite estimates, the rollback and the checksum. What the analysis
 * could not establish reads "not known" (C-30: never shown as safe). The
 * classification badges need a `TooltipProvider` above (the app shell has one).
 */
export function PlanAnalysisBlock({
  overall,
  migrations,
  headingLevel = 2,
}: PlanAnalysisBlockProps): ReactNode {
  const inner: HeadingLevel = headingLevel < 6 ? ((headingLevel + 1) as HeadingLevel) : 6
  return (
    <PlanBlock title="Analysis" headingLevel={headingLevel} data-plan-block="analysis">
      {overall === null ? (
        <p className="text-sm">
          The overall analysis is <NotKnown />.
        </p>
      ) : (
        <Facts
          items={[
            {
              id: 'overall-compatibility',
              label: 'Compatibility',
              value: <EnumValue value={overall.compatibility} labels={COMPATIBILITY} />,
            },
            {
              id: 'overall-lock',
              label: 'Strongest lock',
              value: <EnumValue value={overall.lockSeverity} labels={LOCK_SEVERITY} />,
            },
            {
              id: 'overall-drops',
              label: 'Drops objects',
              value: (
                <YesNo
                  value={overall.destructive}
                  yes="Yes: the plan drops objects"
                  no="No objects dropped"
                />
              ),
            },
            {
              id: 'overall-transaction',
              label: 'Transaction',
              value: (
                <YesNo
                  value={overall.nontransactional}
                  yes="Not in one transaction: a failure can leave the change half applied"
                  no="In one transaction"
                />
              ),
            },
          ]}
        />
      )}
      {migrations === null ? (
        <p className="text-sm">
          The analysis per migration is <NotKnown />.
        </p>
      ) : (
        keyedBy(migrations, (m) => m.migrationId).map(({ item: migration, key }) => (
          <MigrationSection key={key} migration={migration} headingLevel={inner} />
        ))
      )}
    </PlanBlock>
  )
}
