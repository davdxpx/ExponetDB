import { Check, ChevronDown } from '@exponetdb/icons'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Skeleton,
} from '@exponetdb/ui'
import {
  isAppPath,
  ObservedTime,
  type Readable,
  readableValue,
  TierChip,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useMatch, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import {
  type Environment,
  type EnvironmentList,
  environmentHref,
  type Lifecycle,
  type Tier,
} from './environments.ts'
import { parseTargetParams, type TargetRoute } from './params.ts'
import { type Target, useProjectEnvironments, useTarget } from './queries.ts'

/** The route id of the target layout (`src/routes/_app/t/$product/$project/$environment.tsx`). */
const TARGET_ROUTE_ID = '/_app/t/$product/$project/$environment' as const

/**
 * `Product / Project / Environment ▾` for the header of a target page
 * (information-architecture.md section 3). Product and project are text (their
 * slugs); the environment is a menu of the project's environments, each with
 * the chip of its tier, and the current environment always shows its own
 * chip: the production cue of the header. The tier is the target's `tier`
 * field, never a guess from the slug. Choosing an environment goes to the
 * same page there (the section and a schema kind stay, an object name does
 * not). Renders nothing outside a target page, for a target the server says
 * is not there, and for route parameters that fail the slug grammar.
 */
export function TargetContextBar(): ReactNode {
  const match = useMatch({ from: TARGET_ROUTE_ID, shouldThrow: false })
  const target = match === undefined ? undefined : parseTargetParams(match.params)
  if (target === undefined) return null
  return <ContextBar target={target} />
}

type CurrentTier = Tier | 'loading' | 'unknown'

/** The tier of the environment the person is on: from its own read, else from the project's list. */
function currentTier(
  read: Readable<Target>,
  environments: Readable<EnvironmentList>,
  target: TargetRoute,
): CurrentTier {
  const own = readableValue(read)?.tier
  if (own !== undefined) return own
  const listed = readableValue(environments)?.environments.find(
    (environment) => environment.slug === target.environment,
  )
  if (listed !== undefined) return listed.tier
  return read.state === 'loading' || environments.state === 'loading' ? 'loading' : 'unknown'
}

function ContextBar({ target }: { readonly target: TargetRoute }): ReactNode {
  const read = useTarget(target.path)
  const environments = useProjectEnvironments(target.product, target.project)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // The target does not exist or is not visible: the page says so and nothing more.
  if (read.notFound) return null
  return (
    <Breadcrumb
      aria-label={t('target.bar.label')}
      data-slot="target-context-bar"
      className="min-w-0 shrink"
    >
      <BreadcrumbList className="flex-nowrap">
        {/* On a phone the product and project move into the environment menu (it names them). */}
        <BreadcrumbItem className="max-md:hidden">{target.product}</BreadcrumbItem>
        <BreadcrumbSeparator className="max-md:hidden">/</BreadcrumbSeparator>
        <BreadcrumbItem className="max-md:hidden">{target.project}</BreadcrumbItem>
        <BreadcrumbSeparator className="max-md:hidden">/</BreadcrumbSeparator>
        <BreadcrumbItem className="min-w-0">
          <EnvironmentSwitcher
            target={target}
            tier={currentTier(read.readable, environments.readable, target)}
            environments={environments.readable}
            pathname={pathname}
            onRetry={environments.refetch}
          />
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function TierMark({ tier }: { readonly tier: CurrentTier }): ReactNode {
  if (tier === 'loading') return <Skeleton className="h-5 w-20" />
  if (tier === 'unknown') {
    return (
      <span className="rounded-md border border-strong px-2 py-0.5 text-xs text-foreground-light">
        {t('target.tier.unknown')}
      </span>
    )
  }
  return <TierChip tier={tier} />
}

function EnvironmentSwitcher(props: {
  readonly target: TargetRoute
  readonly tier: CurrentTier
  readonly environments: Readable<EnvironmentList>
  readonly pathname: string
  readonly onRetry: () => void
}): ReactNode {
  const { target, tier, environments, pathname, onRetry } = props
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="tiny"
          className="max-w-full"
          iconRight={<ChevronDown className="size-3" />}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="sr-only">{t('target.bar.environment')}</span>{' '}
            <span className="truncate">{target.environment}</span> <TierMark tier={tier} />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel className="font-normal text-foreground-light md:hidden">
          <span className="sr-only">{t('target.bar.label')}: </span>
          {target.product} / {target.project}
        </DropdownMenuLabel>
        <EnvironmentMenu
          readable={environments}
          target={target}
          pathname={pathname}
          onRetry={onRetry}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The menu's content for each state of the read: never an empty menu for a read that failed. */
function EnvironmentMenu(props: {
  readonly readable: Readable<EnvironmentList>
  readonly target: TargetRoute
  readonly pathname: string
  readonly onRetry: () => void
}): ReactNode {
  const { readable, target, pathname, onRetry } = props
  const retry = (label: string): ReactNode => (
    <DropdownMenuItem
      onSelect={(event) => {
        // Stay open: the person watches the read run again.
        event.preventDefault()
        onRetry()
      }}
    >
      {label}
    </DropdownMenuItem>
  )
  switch (readable.state) {
    case 'loading':
      return (
        <>
          <DropdownMenuLabel>{t('target.switcher.loading')}</DropdownMenuLabel>
          <Skeleton className="mx-2 my-1 h-5 w-40" />
          <Skeleton className="mx-2 my-1 h-5 w-32" />
        </>
      )
    case 'failed':
      return (
        <>
          <DropdownMenuLabel className="whitespace-normal">
            {t('target.switcher.failed', {
              reason: t('error.withCode', {
                message: readable.error.message,
                code: readable.error.code,
              }),
            })}
          </DropdownMenuLabel>
          {retry(t('state.retry'))}
        </>
      )
    case 'stale':
      return (
        <>
          <DropdownMenuLabel className="whitespace-normal">
            {t('target.switcher.stale')} <ObservedTime observedAt={readable.observedAt} />.
          </DropdownMenuLabel>
          <EnvironmentItems list={readable.value} target={target} pathname={pathname} />
          {retry(t('state.refresh'))}
        </>
      )
    case 'partial':
      return (
        <>
          <DropdownMenuLabel className="whitespace-normal">
            {t('target.switcher.partial', { missing: readable.missing.join(' ') })}
          </DropdownMenuLabel>
          <EnvironmentItems list={readable.value} target={target} pathname={pathname} />
        </>
      )
    case 'ready':
      return <EnvironmentItems list={readable.value} target={target} pathname={pathname} />
  }
}

function EnvironmentItems(props: {
  readonly list: EnvironmentList
  readonly target: TargetRoute
  readonly pathname: string
}): ReactNode {
  const { list, target, pathname } = props
  if (list.environments.length === 0) {
    return (
      <DropdownMenuLabel className="whitespace-normal">
        {t('target.switcher.empty')}
      </DropdownMenuLabel>
    )
  }
  return list.environments.map((environment) => (
    <EnvironmentItem
      key={environment.slug}
      environment={environment}
      current={environment.slug === target.environment}
      href={environmentHref(target, pathname, environment.slug)}
    />
  ))
}

const LIFECYCLE_LABELS: Readonly<Record<Lifecycle, MessageKey | undefined>> = {
  registered: 'target.lifecycle.registered',
  active: undefined,
  suspended: 'target.lifecycle.suspended',
  decommissioned: 'target.lifecycle.decommissioned',
}

function EnvironmentItem(props: {
  readonly environment: Environment
  readonly current: boolean
  readonly href: string
}): ReactNode {
  const { environment, current, href } = props
  const Link = useLinkComponent()
  const lifecycle = LIFECYCLE_LABELS[environment.state]
  const content = (
    <span className="flex w-full min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{environment.slug}</span>
      {lifecycle === undefined ? null : (
        <span className="text-foreground-lighter">{t(lifecycle)}</span>
      )}
      <TierChip tier={environment.tier} />
      {current ? (
        <>
          <Check aria-hidden className="size-3.5" />
          <span className="sr-only">{t('target.switcher.current')}</span>
        </>
      ) : null}
    </span>
  )
  if (current || !isAppPath(href)) {
    // The environment the person is on, or a path the app would not follow: no link.
    return (
      <DropdownMenuItem aria-current={current ? 'true' : undefined}>{content}</DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuItem asChild>
      <Link href={href}>{content}</Link>
    </DropdownMenuItem>
  )
}
