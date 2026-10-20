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
  NotSupportedState,
  ObservedTime,
  ReadableView,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { targetHref } from '../../shell/navigation.ts'
import type { SchemaKind, TargetRoute } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import { ObjectList, visibilityMissing } from './object-list.tsx'
import { type SchemaOverviewRead, type SchemaRead, useSchemaOverview } from './queries.ts'
import { KIND_ORDER, kindPlan } from './schema-model.ts'
import { SchemaStatus } from './status-block.tsx'
import { TreePanel } from './tree-panel.tsx'
import { Visualizer } from './visualizer.tsx'

const HEADING = 3

/** The page `/schema/<kind>` a class of the overview's counts belongs to, if it has one. */
const CLASS_KIND: ReadonlyMap<string, SchemaKind> = new Map([
  ['schema', 'schemas'],
  ['table', 'tables'],
  ['view', 'views'],
  ['materialized_view', 'materialized-views'],
  ['function', 'functions'],
  ['trigger', 'triggers'],
  ['enum', 'types'],
  ['domain', 'types'],
  ['composite_type', 'types'],
  ['range_type', 'types'],
  ['sequence', 'sequences'],
  ['extension', 'extensions'],
  ['index', 'indexes'],
  ['policy', 'policies'],
  ['publication', 'publications'],
])

const CLASS_LABEL: ReadonlyMap<string, MessageKey> = new Map([
  ['schema', 'schema.class.schema'],
  ['table', 'schema.class.table'],
  ['foreign_table', 'schema.class.foreign_table'],
  ['view', 'schema.class.view'],
  ['materialized_view', 'schema.class.materialized_view'],
  ['function', 'schema.class.function'],
  ['trigger', 'schema.class.trigger'],
  ['enum', 'schema.class.enum'],
  ['domain', 'schema.class.domain'],
  ['composite_type', 'schema.class.composite_type'],
  ['range_type', 'schema.class.range_type'],
  ['sequence', 'schema.class.sequence'],
  ['extension', 'schema.class.extension'],
  ['index', 'schema.class.index'],
  ['policy', 'schema.class.policy'],
  ['column', 'schema.class.column'],
  ['constraint', 'schema.class.constraint'],
  ['rule', 'schema.class.rule'],
  ['publication', 'schema.class.publication'],
  ['event_trigger', 'schema.class.event_trigger'],
])

/** The body of `/schema` and `/schema/<kind>`: the status at the top, then the page of the kind. */
export function SchemaBody(props: {
  readonly target: TargetRoute
  readonly kind: SchemaKind | undefined
}): ReactNode {
  return (
    <div className="flex flex-col gap-8" data-page="schema" data-kind={props.kind ?? 'index'}>
      <SchemaStatus target={props.target} />
      {props.kind === undefined ? (
        <SchemaIndex target={props.target} />
      ) : (
        <KindPage target={props.target} kind={props.kind} />
      )}
    </div>
  )
}

function KindPage(props: { readonly target: TargetRoute; readonly kind: SchemaKind }): ReactNode {
  const plan = kindPlan(props.kind)
  switch (plan.type) {
    case 'objects':
      return (
        <section aria-labelledby="schema-kind-title" className="flex flex-col gap-3">
          <KindNav target={props.target} current={props.kind} />
          <h2 id="schema-kind-title" className="text-lg font-medium">
            {t(plan.titleKey)}
          </h2>
          <ObjectList
            // A new kind starts a new list.
            key={props.kind}
            target={props.target}
            kinds={plan.kinds}
            what={t(plan.titleKey).toLowerCase()}
          />
        </section>
      )
    case 'visualizer':
      return (
        <section aria-labelledby="schema-kind-title" className="flex flex-col gap-3">
          <KindNav target={props.target} current={props.kind} />
          <h2 id="schema-kind-title" className="text-lg font-medium">
            {t('schema.kind.visualizer')}
          </h2>
          <Visualizer path={props.target.path} />
        </section>
      )
    case 'unsupported':
      return (
        <section aria-labelledby="schema-kind-title" className="flex flex-col gap-3">
          <KindNav target={props.target} current={props.kind} />
          <h2 id="schema-kind-title" className="sr-only">
            {t(plan.titleKey)}
          </h2>
          <NotSupportedState
            feature={t(plan.titleKey)}
            requires={t(plan.reasonKey).toLowerCase()}
            headingLevel={3}
          />
        </section>
      )
  }
}

/** The kinds as links; the current one is marked. */
function KindNav(props: {
  readonly target: TargetRoute
  readonly current: SchemaKind | undefined
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <nav aria-label={t('schema.nav.label')}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li>
          <Link
            href={targetHref(props.target, '/schema')}
            className="underline"
            {...(props.current === undefined ? { 'aria-current': 'page' as const } : {})}
          >
            {t('schema.nav.index')}
          </Link>
        </li>
        {KIND_ORDER.map((kind) => (
          <li key={kind}>
            <Link
              href={`${targetHref(props.target, '/schema')}/${kind}`}
              className="underline"
              {...(props.current === kind ? { 'aria-current': 'page' as const } : {})}
            >
              {t(kindTitle(kind))}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function kindTitle(kind: SchemaKind): MessageKey {
  const plan = kindPlan(kind)
  return plan.type === 'visualizer' ? 'schema.kind.visualizer' : plan.titleKey
}

function SchemaIndex(props: { readonly target: TargetRoute }): ReactNode {
  const overview = useSchemaOverview(props.target.path, visibilityMissing)
  return (
    <div className="flex flex-col gap-8">
      <KindNav target={props.target} current={undefined} />
      <section aria-labelledby="schema-overview-title" className="flex flex-col gap-3">
        <h2 id="schema-overview-title" className="text-lg font-medium">
          {t('schema.overview.title')}
        </h2>
        <OverviewView read={overview} target={props.target} />
      </section>
      <section aria-labelledby="schema-tree-title" className="flex flex-col gap-3">
        <h2 id="schema-tree-title" className="text-lg font-medium">
          {t('schema.tree.title')}
        </h2>
        <TreePanel target={props.target} />
      </section>
    </div>
  )
}

export function OverviewView(props: {
  readonly read: SchemaRead<SchemaOverviewRead>
  readonly target: TargetRoute
}): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('schema.overview.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      empty={{
        isEmpty: (value) => value.schemas.length === 0,
        content: <p className="text-sm">{t('schema.overview.empty')}</p>,
      }}
      ready={(value) => <SchemaCounts overview={value} target={props.target} />}
    />
  )
}

function SchemaCounts(props: {
  readonly overview: SchemaOverviewRead
  readonly target: TargetRoute
}): ReactNode {
  const Link = useLinkComponent()
  const { overview } = props
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-foreground-light">
        <ObservedTime observedAt={overview.observedAt} withDate />
      </p>
      <Table>
        <TableCaption className="sr-only">{t('schema.overview.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('schema.overview.schema')}</TableHead>
            <TableHead scope="col">{t('schema.overview.managed')}</TableHead>
            <TableHead scope="col">{t('schema.overview.objects')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {overview.schemas.map((schema) => (
            <TableRow key={schema.name}>
              <TableCell>
                <UntrustedName name={schema.name} mono label={t('schema.overview.schema')} />
              </TableCell>
              <TableCell>
                {schema.managed ? t('schema.overview.managedYes') : t('schema.overview.managedNo')}
              </TableCell>
              <TableCell>
                <ul className="flex flex-wrap gap-x-4 gap-y-1">
                  {Object.entries(schema.objectCounts)
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([cls, count]) => {
                      const label = CLASS_LABEL.get(cls)
                      const page = CLASS_KIND.get(cls)
                      const text =
                        label === undefined ? (
                          <UntrustedName name={cls} mono label={t('schema.overview.objects')} />
                        ) : (
                          t(label)
                        )
                      return (
                        <li key={cls} data-class={cls}>
                          {page === undefined ? (
                            text
                          ) : (
                            <Link
                              href={`${targetHref(props.target, '/schema')}/${page}`}
                              className="underline"
                            >
                              {text}
                            </Link>
                          )}{' '}
                          <span className="text-foreground-light">{count}</span>
                        </li>
                      )
                    })}
                </ul>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
