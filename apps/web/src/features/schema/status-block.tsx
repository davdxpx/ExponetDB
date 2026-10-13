import type { Finding } from '@exponetdb/sdk/operations'
import {
  KeyValueList,
  MarkedCode,
  ObservedTime,
  ReadableView,
  SourceLabel,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { targetHref } from '../../shell/navigation.ts'
import { readSourceOf } from '../target/gate.ts'
import type { TargetRoute } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import {
  type DriftFindings,
  type FingerprintRead,
  type SchemaRead,
  useDriftFindings,
  useSchemaFingerprint,
} from './queries.ts'

const HEADING = 3

/** The link to the SQL page in draft mode: the only place a change starts from the schema browser. */
export function draftHref(target: TargetRoute): string {
  return `${targetHref(target, '/sql')}?mode=draft`
}

/**
 * The top of the schema browser: the `fp1` fingerprint of the schema, what the
 * Control Plane knows about drift, and the one way to change anything: a link
 * to the SQL page in draft mode. Nothing here changes a database.
 */
export function SchemaStatus(props: { readonly target: TargetRoute }): ReactNode {
  const Link = useLinkComponent()
  const fingerprint = useSchemaFingerprint(props.target.path, (value) =>
    value.complete ? undefined : [t('schema.fingerprint.incomplete')],
  )
  const drift = useDriftFindings(props.target.path, (value) =>
    value.nextCursor === null ? undefined : [t('schema.drift.more')],
  )
  return (
    <section
      aria-labelledby="schema-status-title"
      className="flex flex-col gap-4 rounded-md border border-default p-4"
      data-block="schema-status"
    >
      <h2 id="schema-status-title" className="text-lg font-medium">
        {t('schema.status.title')}
      </h2>
      <FingerprintView read={fingerprint} />
      <DriftView read={drift} />
      <p className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href={targetHref(props.target, '/drift')} className="text-foreground underline">
          {t('schema.drift.link')}
        </Link>
        <Link href={draftHref(props.target)} className="text-foreground underline">
          {t('schema.draft.link')}
        </Link>
      </p>
      <p className="text-sm text-foreground-light">{t('schema.draft.hint')}</p>
    </section>
  )
}

export function FingerprintView(props: { readonly read: SchemaRead<FingerprintRead> }): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('schema.fingerprint.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      ready={(value) => <FingerprintBody value={value} />}
    />
  )
}

function FingerprintBody({ value }: { readonly value: FingerprintRead }): ReactNode {
  const known = readSourceOf(value.source)
  return (
    <div className="flex flex-col gap-2" data-slot="fingerprint">
      <KeyValueList
        items={[
          {
            id: 'fingerprint',
            label: t('schema.fingerprint.label'),
            // A fingerprint from the server is shown exactly, marked: a look-alike character is visible.
            value: <MarkedCode text={value.fingerprint} />,
            copyText: value.fingerprint,
          },
          {
            id: 'canonicalizer',
            label: t('schema.fingerprint.canonicalizer'),
            value: <MarkedCode text={value.canonicalizer} />,
          },
          {
            id: 'entries',
            label: t('schema.fingerprint.entries'),
            value: String(value.entries),
          },
          {
            id: 'pg',
            label: t('schema.fingerprint.pgMajor'),
            value: String(value.pgMajor),
          },
          {
            id: 'observed',
            label: t('schema.fingerprint.observed'),
            value: (
              <span className="inline-flex flex-wrap items-center gap-2">
                {known === undefined ? null : <SourceLabel source={known} />}
                <ObservedTime observedAt={value.observedAt} withDate />
              </span>
            ),
          },
        ]}
      />
      {value.complete ? null : (
        <p role="note" className="text-sm">
          {t('schema.fingerprint.incomplete')}
        </p>
      )}
      {value.visibility.complete ? null : (
        <p role="note" className="text-sm" data-slot="visibility">
          {t('schema.visibility.gaps', {
            gaps: value.visibility.gapCount,
            schemas: value.visibility.missingSchemas.length,
          })}
        </p>
      )}
    </div>
  )
}

export function DriftView(props: { readonly read: SchemaRead<DriftFindings> }): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('schema.drift.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      ready={(value, meta) => (
        <DriftBody items={value.items} observedAt={meta.observedAt} source={meta.source} />
      )}
    />
  )
}

function newest(items: readonly Finding[]): string | undefined {
  return items.reduce<string | undefined>(
    (best, finding) =>
      best === undefined || finding.lastSeenAt > best ? finding.lastSeenAt : best,
    undefined,
  )
}

function DriftBody(props: {
  readonly items: readonly Finding[]
  readonly observedAt: string
  readonly source: Parameters<typeof SourceLabel>[0]['source']
}): ReactNode {
  const open = props.items.filter((finding) => finding.state === 'open')
  const last = newest(open)
  return (
    <div className="flex flex-col gap-1 text-sm" data-slot="drift" data-open={open.length}>
      <p>
        {open.length === 0
          ? t('schema.drift.none')
          : t('schema.drift.open', { count: open.length })}
      </p>
      {last === undefined ? null : (
        <p className="text-foreground-light">
          {t('schema.drift.lastSeen')} <ObservedTime observedAt={last} withDate />
        </p>
      )}
      <p className="inline-flex flex-wrap items-center gap-2 text-foreground-light">
        <SourceLabel source={props.source} />
        <ObservedTime observedAt={props.observedAt} />
        <span>{t('schema.drift.note')}</span>
      </p>
    </div>
  )
}
