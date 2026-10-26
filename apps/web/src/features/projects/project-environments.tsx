import { Plus, Search } from '@exponetdb/icons'
import { Button, Input } from '@exponetdb/ui'
import {
  formatCount,
  LinkCard,
  ReadableView,
  TierChip,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ChangeEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { targetHref } from '../../shell/navigation.ts'
import { HealthCell } from '../fleet/health.tsx'
import { lifecycleLabelKey } from '../target/environments.ts'
import { environmentsQuery } from '../target/keys.ts'
import { REGISTER_PATH } from '../targets/targets-page.tsx'
import { type ProjectEnvironment, projectEnvironments } from './model.ts'

/** Environment cards shown before a search and "Show all" take over. */
export const ENVIRONMENTS_SHOWN = 12

/**
 * The environments of the project, each a card that is a link to its target's overview: the
 * environment, its tier (production marked with the reserved token, on the card's edge too), its
 * lifecycle when it is not active and its health with source and age. One read: the target list
 * the server filters by product and project (the read the environment switcher shares). Many
 * environments get a search and "Show all" instead of a hundred large cards.
 */
export function ProjectEnvironments({
  product,
  project,
}: {
  readonly product: string
  readonly project: string
}): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const query = useQuery(environmentsQuery(client, product, project))
  return (
    <section aria-labelledby="project-environments" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id="project-environments" className="m-0 text-base font-medium">
            {t('project.environments.title')}
          </h2>
          <p className="m-0 text-xs text-foreground-light">
            {t('project.environments.description')}
          </p>
        </div>
        <Button asChild size="tiny" variant="default" icon={<Plus aria-hidden="true" />}>
          <Link href={REGISTER_PATH}>{t('project.environments.register')}</Link>
        </Button>
      </div>
      <ReadableView
        readable={toReadable(query, {
          missing: (value) =>
            value.nextCursor === null ? undefined : [t('project.environments.more')],
        })}
        what={t('project.environments.what')}
        onRetry={() => void query.refetch()}
        onRefresh={() => void query.refetch()}
        busy={query.isFetching}
        headingLevel={3}
        empty={{
          isEmpty: (value) => projectEnvironments(value.items, product, project).length === 0,
          content: (
            <p className="m-0 text-sm text-foreground-light">{t('project.environments.empty')}</p>
          ),
        }}
        ready={(value) => (
          <EnvironmentCards environments={projectEnvironments(value.items, product, project)} />
        )}
      />
    </section>
  )
}

function EnvironmentCards({
  environments,
}: {
  readonly environments: readonly ProjectEnvironment[]
}): ReactNode {
  const id = useId()
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  // "Show all" removes itself: the focus moves to the first card it revealed.
  useEffect(() => {
    if (all) listRef.current?.querySelectorAll('a')[ENVIRONMENTS_SHOWN]?.focus()
  }, [all])
  const many = environments.length > ENVIRONMENTS_SHOWN
  const needle = q.trim().toLowerCase()
  const matching =
    needle === '' ? environments : environments.filter((e) => e.slug.includes(needle))
  const shown = all || needle !== '' ? matching : matching.slice(0, ENVIRONMENTS_SHOWN)
  return (
    <div className="flex flex-col gap-3">
      {many ? (
        <div className="relative w-full sm:w-64">
          <label htmlFor={id} className="sr-only">
            {t('project.environments.search')}
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-foreground-lighter"
          />
          <Input
            id={id}
            type="search"
            size="tiny"
            className="pl-7"
            value={q}
            maxLength={39}
            placeholder={t('project.environments.search')}
            autoComplete="off"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQ(event.target.value)}
          />
        </div>
      ) : null}
      {many ? (
        <p role="status" className="sr-only">
          {t('project.environments.matching', {
            shown: formatCount(shown.length),
            total: formatCount(environments.length),
          })}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('project.environments.noMatch')}</p>
      ) : null}
      <ul
        ref={listRef}
        aria-label={t('project.environments.title')}
        className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-4"
      >
        {shown.map((environment) => (
          <li key={environment.target.id} data-environment={environment.slug} className="min-w-0">
            <EnvironmentCard environment={environment} />
          </li>
        ))}
      </ul>
      {many && !all && needle === '' ? (
        <div>
          <Button type="button" size="tiny" variant="default" onClick={() => setAll(true)}>
            {t('project.environments.showAll', { count: formatCount(environments.length) })}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function EnvironmentCard({ environment }: { readonly environment: ProjectEnvironment }): ReactNode {
  const { target, slug } = environment
  const [product = '', project = ''] = target.path.split('/')
  const lifecycle = lifecycleLabelKey(target.state)
  return (
    <LinkCard
      href={targetHref({ product, project, environment: slug })}
      tone={target.tier === 'nonprod' ? 'neutral' : 'production'}
      className="h-full gap-3 p-4"
    >
      <span className="flex flex-wrap items-center gap-2 pr-6">
        <span className="font-mono text-base font-medium">{slug}</span>
        <TierChip tier={target.tier} />
        {lifecycle === undefined ? null : (
          <span className="text-xs text-foreground-lighter">{t(lifecycle)}</span>
        )}
      </span>
      <span className="font-mono text-xs text-foreground-light">{target.path}</span>
      <span className="mt-auto">
        <HealthCell health={target.health} inLink />
      </span>
    </LinkCard>
  )
}
