import type { LedgerEntry, MigrationStatus } from '@exponetdb/sdk/operations'
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
  Admonition,
  ObservedTime,
  SourceLabel,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { readSourceOf } from '../target/gate.ts'
import { nounPhrase } from '../target/phrases.ts'
import { operationPath } from '../target-ops/ids.ts'
import { ledgerQuery } from '../target-ops/keys.ts'
import { useTargetPath } from '../target-ops/links.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'

/**
 * The target's ledger (`GET /targets/{t}/migrations`, `migrations.read`): the
 * applied entries with checksum, who and when (the operation), and the
 * verification of each, then the bundles of the project that are still
 * pending. The ledger in the target is the truth (constitution source-of-truth
 * map); the answer says whether the Control Store mirror agrees.
 */
export function LedgerSection(): ReactNode {
  const { client } = useApi()
  const path = useTargetPath()
  const query = useQuery(ledgerQuery(client, path))
  return (
    <Section
      id="ledger"
      title={t('migrations.ledger.title')}
      description={t('migrations.ledger.description')}
    >
      <ReadSection
        query={query}
        what={nounPhrase('migrations.ledger.what')}
        permission="migrations.read"
        ready={(status) => <LedgerBody status={status} />}
      />
    </Section>
  )
}

function LedgerBody({ status }: { readonly status: MigrationStatus }): ReactNode {
  const source = readSourceOf(status.source)
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground-light">
        {source === undefined ? (
          <span>{t('migrations.ledger.sourceUnknown')}</span>
        ) : (
          <SourceLabel source={source} />
        )}
        <span className="min-w-0 max-w-full">
          {t('migrations.ledger.observed')} <ObservedTime observedAt={status.observedAt} withDate />
        </span>
        {status.baselineId === null ? null : (
          <span className="min-w-0 max-w-full">
            {t('migrations.ledger.baseline')}{' '}
            <UntrustedName name={status.baselineId} mono label={t('migrations.ledger.baseline')} />
          </span>
        )}
        {status.ledgerStateHash === null ? null : (
          <span className="min-w-0 max-w-full">
            {t('migrations.ledger.hash')}{' '}
            <UntrustedName
              name={status.ledgerStateHash}
              mono
              maxCodePoints={24}
              label={t('migrations.ledger.hash')}
            />
          </span>
        )}
      </p>
      {status.mirror.inSync ? null : (
        <Admonition
          type="warning"
          title={t('migrations.ledger.mirrorDiffers.title')}
          description={t('migrations.ledger.mirrorDiffers.body')}
        />
      )}
      {status.incompleteNontransactional === undefined ||
      status.incompleteNontransactional.length === 0 ? null : (
        <Admonition
          type="warning"
          title={t('migrations.ledger.incomplete.title')}
          description={
            <>
              {t('migrations.ledger.incomplete.body')}{' '}
              {status.incompleteNontransactional.map((id, index) => (
                <span key={id}>
                  {index > 0 ? ', ' : ''}
                  <UntrustedName name={id} mono label={t('migrations.ledger.column.migration')} />
                </span>
              ))}
            </>
          }
        />
      )}
      {status.applied.length === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('migrations.ledger.empty')}</p>
      ) : (
        <LedgerTable entries={status.applied} />
      )}
      <PendingBlock pending={status.pending} />
    </div>
  )
}

function LedgerTable({ entries }: { readonly entries: readonly LedgerEntry[] }): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('migrations.ledger.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('migrations.ledger.column.migration')}</TableHead>
          <TableHead scope="col">{t('migrations.ledger.column.checksum')}</TableHead>
          <TableHead scope="col">{t('migrations.ledger.column.origin')}</TableHead>
          <TableHead scope="col">{t('migrations.ledger.column.applied')}</TableHead>
          <TableHead scope="col">{t('migrations.ledger.column.verification')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const operation = operationPath(entry.operationId)
          return (
            <TableRow
              key={`${entry.migrationId}:${entry.appliedAt}:${entry.checksum}`}
              data-migration={entry.migrationId}
            >
              <TableCell>
                <UntrustedName name={entry.name} label={t('migrations.ledger.column.migration')} />
                <div className="text-xs text-foreground-lighter">
                  <UntrustedName
                    name={entry.migrationId}
                    mono
                    label={t('migrations.ledger.column.migration')}
                  />
                </div>
                {entry.reverted ? (
                  <div className="text-xs text-foreground-light">
                    {t('migrations.ledger.reverted')}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="font-mono text-xs">
                <UntrustedName
                  name={entry.checksum}
                  mono
                  maxCodePoints={40}
                  label={t('migrations.ledger.column.checksum')}
                />
              </TableCell>
              <TableCell>
                <UntrustedName name={entry.origin} label={t('migrations.ledger.column.origin')} />
              </TableCell>
              <TableCell>
                <ObservedTime observedAt={entry.appliedAt} withDate />
                {operation === undefined ? null : (
                  <div className="text-xs">
                    <Link href={operation} className="text-primary underline focus-ring">
                      {t('migrations.ledger.operation')}
                    </Link>
                  </div>
                )}
              </TableCell>
              <TableCell>
                <Verification entry={entry} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** "Verified 3 min ago", "Verification pending": a word for each status, never a color alone. */
function Verification({ entry }: { readonly entry: LedgerEntry }): ReactNode {
  const { status, verifiedAt } = entry.verification
  const label = ((): string | undefined => {
    switch (status) {
      case 'passed':
        return t('migrations.verification.passed')
      case 'pending':
        return t('migrations.verification.pending')
      case 'failed':
        return t('migrations.verification.failed')
      case 'partial':
        return t('migrations.verification.partial')
      case 'error':
        return t('migrations.verification.error')
      default:
        return undefined
    }
  })()
  return (
    <span>
      {label ?? (
        <UntrustedName name={String(status)} label={t('migrations.ledger.column.verification')} />
      )}
      {verifiedAt === null ? null : (
        <>
          {' '}
          <ObservedTime observedAt={verifiedAt} />
        </>
      )}
    </span>
  )
}

function PendingBlock({ pending }: { readonly pending: MigrationStatus['pending'] }): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-base font-medium">{t('migrations.pending.title')}</h3>
      {pending.length === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('migrations.pending.empty')}</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">{t('migrations.pending.caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('migrations.ledger.column.migration')}</TableHead>
              <TableHead scope="col">{t('migrations.ledger.column.checksum')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending.map((bundle) => (
              <TableRow key={bundle.migrationId} data-pending={bundle.migrationId}>
                <TableCell>
                  <UntrustedName
                    name={bundle.name}
                    label={t('migrations.ledger.column.migration')}
                  />
                  <div className="text-xs text-foreground-lighter">
                    <UntrustedName
                      name={bundle.migrationId}
                      mono
                      label={t('migrations.ledger.column.migration')}
                    />
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  <UntrustedName
                    name={bundle.checksum}
                    mono
                    maxCodePoints={40}
                    label={t('migrations.ledger.column.checksum')}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
