import type { Finding, OperationRead } from '@exponetdb/sdk/operations'
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
  ObservedTime,
  ReadableView,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { targetHref } from '../../shell/navigation.ts'
import { planPath } from '../plans/plan-model.ts'
import type { TargetRoute } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import { Block } from './block.tsx'
import {
  type BlockRead,
  type Findings,
  type Operations,
  useTargetFindings,
  useTargetOperations,
} from './queries.ts'

const HEADING = 3

/** The newest operations that name this target. Applied and verified are separate columns (C-28). */
export function OperationsBlock(props: { readonly path: string }): ReactNode {
  const Link = useLinkComponent()
  const read = useTargetOperations(props.path, (value) =>
    value.nextCursor === null ? undefined : [t('overview.operations.more')],
  )
  return (
    <Block
      id="operations"
      title={t('overview.operations.title')}
      description={t('overview.operations.description')}
    >
      <OperationsView read={read} />
      <Link href="/changes/plans" className="text-sm text-foreground underline">
        {t('overview.operations.link')}
      </Link>
    </Block>
  )
}

export function OperationsView(props: { readonly read: BlockRead<Operations> }): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('overview.operations.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      empty={{
        isEmpty: (value) => value.items.length === 0,
        content: <p className="text-sm">{t('overview.operations.empty')}</p>,
      }}
      ready={(value) => <OperationTable items={value.items} />}
    />
  )
}

function OperationTable({ items }: { readonly items: readonly OperationRead[] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('overview.operations.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('overview.operations.column.operation')}</TableHead>
          <TableHead scope="col">{t('overview.operations.column.kind')}</TableHead>
          <TableHead scope="col">{t('overview.operations.column.state')}</TableHead>
          <TableHead scope="col">{t('overview.operations.column.applied')}</TableHead>
          <TableHead scope="col">{t('overview.operations.column.verified')}</TableHead>
          <TableHead scope="col">{t('overview.operations.column.updated')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((operation) => {
          const href = operation.planId === null ? undefined : planPath(operation.planId)
          return (
            <TableRow key={operation.id} data-operation={operation.id}>
              <TableCell className="font-mono text-xs">
                {href === undefined ? (
                  <UntrustedName
                    name={operation.id}
                    mono
                    label={t('overview.operations.column.operation')}
                  />
                ) : (
                  <Link href={href} className="text-primary underline focus-ring">
                    {operation.id}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <UntrustedName
                  name={operation.kind}
                  mono
                  label={t('overview.operations.column.kind')}
                />
              </TableCell>
              <TableCell>{operation.state}</TableCell>
              <TableCell>{operation.applyOutcome}</TableCell>
              <TableCell>{operation.verificationOutcome}</TableCell>
              <TableCell>
                <ObservedTime observedAt={operation.updatedAt} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** The open findings of the target, newest first as the server sorts them. */
export function FindingsBlock(props: {
  readonly target: TargetRoute
  readonly openCount: number
}): ReactNode {
  const Link = useLinkComponent()
  const read = useTargetFindings(props.target.path, (value) =>
    value.nextCursor === null ? undefined : [t('overview.findings.more')],
  )
  return (
    <Block
      id="findings"
      title={t('overview.findings.title')}
      description={t('overview.findings.description')}
    >
      <p className="text-sm text-foreground-light" data-slot="finding-count">
        {t('overview.findings.countHeader', { count: props.openCount })}
      </p>
      <FindingsView read={read} />
      <Link
        href={targetHref(props.target, '/findings')}
        className="text-sm text-foreground underline"
      >
        {t('overview.findings.link')}
      </Link>
    </Block>
  )
}

export function FindingsView(props: { readonly read: BlockRead<Findings> }): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('overview.findings.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      empty={{
        isEmpty: (value) => value.items.length === 0,
        content: <p className="text-sm">{t('overview.findings.empty')}</p>,
      }}
      ready={(value) => <FindingTable items={value.items} />}
    />
  )
}

function FindingTable({ items }: { readonly items: readonly Finding[] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('overview.findings.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('overview.findings.column.severity')}</TableHead>
          <TableHead scope="col">{t('overview.findings.column.code')}</TableHead>
          <TableHead scope="col">{t('overview.findings.column.summary')}</TableHead>
          <TableHead scope="col">{t('overview.findings.column.seen')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((finding) => (
          <TableRow key={finding.id} data-finding={finding.id} data-severity={finding.severity}>
            <TableCell>
              {t(`overview.health.severity.${finding.severity}`)}
              {finding.securityRelevant ? (
                <span className="text-xs text-foreground-light">
                  {' '}
                  ({t('overview.findings.security')})
                </span>
              ) : null}
            </TableCell>
            <TableCell>
              <UntrustedName name={finding.code} mono label={t('overview.findings.column.code')} />
            </TableCell>
            <TableCell>
              {/* The summary is text from a check or a catalog: data, never markup. */}
              <UntrustedText
                text={finding.summary}
                maxLines={3}
                label={t('overview.findings.column.summary')}
              />
              <span className="text-xs text-foreground-light">
                {t('overview.findings.occurrences', { count: finding.occurrences })}
              </span>
            </TableCell>
            <TableCell>
              <ObservedTime observedAt={finding.lastSeenAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
