import type { SchemaDiff } from '@exponetdb/sdk/operations'
import { Button, cn } from '@exponetdb/ui'
import { type SchemaDiffEntry, SchemaDiffView } from '@exponetdb/ui-data'
import {
  Admonition,
  NotPermittedState,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  type Readable,
  ReadableView,
  readableValue,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { targetHref } from '../../shell/navigation.ts'
import { ContentWrapper } from '../target/content-wrapper.tsx'
import type { EnvironmentList } from '../target/environments.ts'
import type { TargetRoute } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import { useProjectEnvironments } from '../target/queries.ts'
import { useTargetScope } from '../target/scope.tsx'
import { Section } from '../target-ops/section.tsx'
import { DIFF_STALE_AFTER_MS, schemaDiffQuery } from './keys.ts'
import { diffCounts, diffEntries, namedRefusal } from './model.ts'

/**
 * Compare environments (`/t/<product>/<project>/<environment>/compare?to=<environment>`):
 * the schema of this target against the target of another environment of
 * the same project, read only (`POST /schema-diffs`, left = this target,
 * right = the other). The other environment must be one of the project's
 * environments the person may see (the list the environment switcher
 * reads); anything else is a named state and nothing is requested. A
 * comparison the server cannot make (different canonicalizers or PostgreSQL
 * majors, a stale sample, a changed identity) is a named state, never "no
 * differences". There is no merge or apply here: a difference becomes a
 * change only as an authored migration.
 */
export function ComparePage({ to }: { readonly to: string | undefined }): ReactNode {
  const scope = useTargetScope()
  const value = readableValue(scope.read)
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle
              productionCue={
                value !== undefined && value.tier === 'prod' ? <TierChip tier="prod" /> : undefined
              }
            >
              {t('compare.title')}
            </PageHeaderTitle>
            <PageHeaderDescription>{t('compare.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-8 py-6">
        <ContentWrapper
          requires={[]}
          target={scope.read}
          feature={t('compare.title')}
          onRetry={scope.refetch}
          busy={scope.fetching}
        >
          {value === undefined ? null : <CompareBody route={scope.target} to={to} />}
        </ContentWrapper>
      </PageContainer>
    </>
  )
}

function CompareBody({
  route,
  to,
}: {
  readonly route: TargetRoute
  readonly to: string | undefined
}): ReactNode {
  const environments = useProjectEnvironments(route.product, route.project)
  const Link = useLinkComponent()
  const list = readableValue(environments.readable)
  return (
    <>
      <Section
        id="compare-with"
        title={t('compare.pick.title')}
        description={t('compare.pick.description', { environment: route.environment })}
      >
        <ReadableView
          readable={environments.readable}
          what={nounPhrase('compare.environments.what')}
          onRetry={environments.refetch}
          onRefresh={environments.refetch}
          busy={environments.fetching}
          headingLevel={3}
          empty={{
            isEmpty: (value) => value.environments.every((e) => e.slug === route.environment),
            content: (
              <p className="m-0 text-sm text-foreground-light" data-empty="environments">
                {t('compare.pick.none')}
              </p>
            ),
          }}
          ready={(value) => <EnvironmentPicker list={value} route={route} to={to} />}
        />
        <p className="m-0 text-sm">
          <Link
            href={targetHref(route, '/migrations')}
            className="text-primary underline focus-ring"
          >
            {t('compare.migrations')}
          </Link>
        </p>
      </Section>
      <Section
        id="differences"
        title={t('compare.diff.title')}
        description={
          to === undefined
            ? t('compare.diff.pickFirst')
            : t('compare.diff.description', { left: route.environment, right: to })
        }
      >
        <DiffTarget route={route} to={to} list={list} listRead={environments.readable} />
      </Section>
    </>
  )
}

function EnvironmentPicker({
  list,
  route,
  to,
}: {
  readonly list: EnvironmentList
  readonly route: TargetRoute
  readonly to: string | undefined
}): ReactNode {
  const Link = useLinkComponent()
  const others = list.environments.filter((e) => e.slug !== route.environment)
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0" data-compare-picker>
      {others.map((environment) => {
        const current = environment.slug === to
        return (
          <li key={environment.slug}>
            <Link
              href={`${targetHref(route, '/compare')}?to=${environment.slug}`}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border border-default px-2 py-1 text-sm focus-ring hover:bg-surface-200',
                current && 'bg-surface-200 font-medium',
              )}
            >
              <span className="font-mono">{environment.slug}</span>
              {environment.tier === 'prod' ? (
                <TierChip tier="prod" name={environment.slug} />
              ) : null}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/** Which comparison to read, if any: only an environment of the project that the person may see. */
function DiffTarget({
  route,
  to,
  list,
  listRead,
}: {
  readonly route: TargetRoute
  readonly to: string | undefined
  readonly list: EnvironmentList | undefined
  readonly listRead: Readable<EnvironmentList>
}): ReactNode {
  if (to === undefined) {
    return (
      <p className="m-0 text-sm text-foreground-light" data-compare-state="pick">
        {t('compare.state.pick')}
      </p>
    )
  }
  if (to === route.environment) {
    return (
      <p className="m-0 text-sm" data-compare-state="same">
        {t('compare.state.same', { environment: to })}
      </p>
    )
  }
  if (list === undefined) {
    return (
      <p className="m-0 text-sm text-foreground-light" data-compare-state="unchecked">
        {listRead.state === 'failed'
          ? t('compare.state.listFailed', { environment: to })
          : t('compare.state.listLoading')}
      </p>
    )
  }
  const other = list.environments.find((e) => e.slug === to)
  if (other === undefined) {
    return (
      <p className="m-0 text-sm" data-compare-state="unknown-environment">
        {list.missing.length > 0
          ? t('compare.state.notListedPartial', { environment: to })
          : t('compare.state.notListed', { environment: to })}
      </p>
    )
  }
  return <DiffRead left={route.path} right={other.path} rightSlug={other.slug} />
}

function DiffRead({
  left,
  right,
  rightSlug,
}: {
  readonly left: string
  readonly right: string
  readonly rightSlug: string
}): ReactNode {
  const { client } = useApi()
  const query = useQuery(schemaDiffQuery(client, left, right))
  const refetch = () => void query.refetch()
  if (query.data === undefined && query.isError) {
    const failure = classifyFailure(query.error)
    if (failure.kind === 'not_permitted') {
      return (
        <NotPermittedState
          what={nounPhrase('compare.diff.what')}
          permission="schema.read"
          headingLevel={3}
        />
      )
    }
    const named = namedRefusal(failure.code)
    if (named !== undefined) {
      return (
        <div data-compare-state={named}>
          <Admonition
            type="warning"
            title={t(`compare.refusal.${named}.title`)}
            description={
              <span className="flex flex-col gap-1">
                <span>{t(`compare.refusal.${named}.body`)}</span>
                <span>{t('error.withCode', { message: failure.message, code: failure.code })}</span>
              </span>
            }
            actions={
              <Button
                type="button"
                size="tiny"
                variant="default"
                loading={query.isFetching}
                onClick={refetch}
              >
                {t('state.retry')}
              </Button>
            }
          />
        </div>
      )
    }
  }
  const readable = toReadable(query, {
    staleAfterMs: DIFF_STALE_AFTER_MS,
    missing: (diff) => {
      if (!diff.truncated) return undefined
      const counts = diffCounts(diff)
      return [t('compare.truncated', { listed: counts.listed, total: counts.total })]
    },
  })
  const diff = readableValue(readable)
  if (diff !== undefined && !diff.comparable) {
    return (
      <div data-compare-state="not_comparable" className="flex flex-col gap-3">
        <Admonition
          type="warning"
          title={t('compare.notComparable.title')}
          description={t('compare.notComparable.body')}
          actions={
            <Button
              type="button"
              size="tiny"
              variant="default"
              loading={query.isFetching}
              onClick={refetch}
            >
              {t('state.refresh')}
            </Button>
          }
        />
        <Fingerprints diff={diff} rightSlug={rightSlug} />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3" data-compare-state="diff">
      {diff === undefined ? null : <Summary diff={diff} rightSlug={rightSlug} />}
      <SchemaDiffView
        diff={entriesOf(readable)}
        what={nounPhrase('compare.diff.what')}
        onRetry={refetch}
        onRefresh={refetch}
        busy={query.isFetching}
        headingLevel={3}
      />
    </div>
  )
}

function entriesOf(readable: Readable<SchemaDiff>): Readable<readonly SchemaDiffEntry[]> {
  if (readable.state === 'loading' || readable.state === 'failed') return readable
  return { ...readable, value: diffEntries(readable.value) }
}

function Fingerprints({
  diff,
  rightSlug,
}: {
  readonly diff: SchemaDiff
  readonly rightSlug: string
}): ReactNode {
  return (
    <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      <dt className="text-foreground-light">{t('compare.fingerprint.left')}</dt>
      <dd className="m-0 min-w-0 break-all">
        <UntrustedName
          name={diff.left.fingerprint}
          mono
          maxCodePoints={80}
          label={t('compare.fingerprint.left')}
        />
      </dd>
      <dt className="text-foreground-light">
        {t('compare.fingerprint.right', { environment: rightSlug })}
      </dt>
      <dd className="m-0 min-w-0 break-all">
        <UntrustedName
          name={diff.right.fingerprint}
          mono
          maxCodePoints={80}
          label={t('compare.fingerprint.right', { environment: rightSlug })}
        />
      </dd>
    </dl>
  )
}

function Summary({
  diff,
  rightSlug,
}: {
  readonly diff: SchemaDiff
  readonly rightSlug: string
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <Fingerprints diff={diff} rightSlug={rightSlug} />
      <p className="m-0 text-sm" data-compare-totals>
        {t('compare.totals', {
          added: diff.totals.added,
          removed: diff.totals.removed,
          changed: diff.totals.changed,
          matched: diff.totals.matched,
          security: diff.totals.securityRelevant,
        })}
      </p>
      <p className="m-0 text-xs text-foreground-light">
        {t('compare.direction', { environment: rightSlug })}
      </p>
    </div>
  )
}
