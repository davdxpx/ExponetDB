import { cn } from '@exponetdb/ui'
import {
  formatUtc,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
  StateBadge,
  UntrustedName,
  useLinkComponent,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import {
  type ExpiryState,
  expiryState,
  knownNodeState,
  nodeHealth,
  skewBeyondTolerance,
} from './model.ts'

/**
 * Small building blocks of the infrastructure pages: the page frame, a
 * section, a node's state, a link to an object that falls back to its id as
 * text, and an expiry with its warning. Every name the server or a node
 * reported is rendered through `UntrustedName` (C-26).
 */
export function InfraPage({
  title,
  description,
  production = false,
  children,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  /** The page shows a production object: the reserved production frame (C-24). */
  readonly production?: boolean
  readonly children: ReactNode
}): ReactNode {
  return (
    <div
      data-slot="infrastructure-page"
      data-production-frame={production ? '' : undefined}
      className={cn('flex min-w-0 flex-col', production && 'border-2 border-production')}
    >
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{title}</PageHeaderTitle>
            {description === undefined ? null : (
              <PageHeaderDescription>{description}</PageHeaderDescription>
            )}
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-10 py-6">
        {children}
      </PageContainer>
    </div>
  )
}

export function InfraSection({
  id,
  title,
  description,
  children,
}: {
  readonly id: string
  readonly title: string
  readonly description?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  return (
    <PageSection id={id} aria-labelledby={`${id}-title`}>
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle id={`${id}-title`}>{title}</PageSectionTitle>
          {description === undefined ? null : (
            <PageSectionDescription>{description}</PageSectionDescription>
          )}
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent className="flex flex-col gap-3">{children}</PageSectionContent>
    </PageSection>
  )
}

/** A link to an object's page, or its id as text when the id is not in the page's grammar. */
export function ObjectLink({
  href,
  text,
  label,
}: {
  readonly href: string | undefined
  readonly text: string
  readonly label: string
}): ReactNode {
  const Link = useLinkComponent()
  if (href === undefined) return <UntrustedName name={text} mono label={label} />
  return (
    <Link href={href} className="font-mono text-xs text-primary underline focus-ring">
      {text}
    </Link>
  )
}

/**
 * A node's state: the health badge (only `active` is green; `unknown` and
 * `pending_enrollment` never are) and the state's own word, so `revoked` and
 * `offline` are told apart even where they share a color.
 */
export function NodeStateBadge({
  state,
  source,
  observedAt,
}: {
  readonly state: string
  readonly source?: string
  readonly observedAt?: string
}): ReactNode {
  const known = knownNodeState(state)
  const readSource =
    source === 'live' ||
    source === 'sampled' ||
    source === 'cached' ||
    source === 'agent_reported' ||
    source === 'inferred'
      ? source
      : undefined
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-node-state={known}>
      <StateBadge
        state={nodeHealth(state)}
        {...(readSource === undefined ? {} : { source: readSource })}
        {...(observedAt === undefined ? {} : { observedAt })}
      />
      <span className="text-xs text-foreground-light">{t(`infra.node.state.${known}`)}</span>
    </span>
  )
}

/** The clock skew the agent reported, with a warning beyond the 30 seconds jobs tolerate. */
export function ClockSkew({ skewMs }: { readonly skewMs: number | null }): ReactNode {
  if (skewMs === null) return <span>{t('infra.node.skew.notReported')}</span>
  const beyond = skewBeyondTolerance(skewMs)
  return (
    <span data-skew={beyond ? 'beyond' : 'within'} className={cn(beyond && 'text-warning-600')}>
      {t('infra.node.skew.value', { ms: skewMs })}
      {beyond ? ` ${t('infra.node.skew.beyond')}` : null}
    </span>
  )
}

const EXPIRY_CLASS: Readonly<Record<ExpiryState, string>> = {
  expired: 'text-destructive-600',
  soon: 'text-warning-600',
  valid: 'text-foreground',
  not_yet: 'text-warning-600',
  unknown: 'text-foreground-light',
}

/** An expiry time with its state: expired, expiring soon (with the warning window), valid. */
export function Expiry({
  notAfter,
  notBefore,
  warnMs,
}: {
  readonly notAfter: string
  readonly notBefore?: string
  readonly warnMs?: number
}): ReactNode {
  const now = useResolvedNow()
  const state = expiryState(notAfter, now, warnMs, notBefore)
  return (
    <span data-expiry={state} className={cn('text-sm', EXPIRY_CLASS[state])}>
      {t(`infra.expiry.${state}`, { time: formatUtc(notAfter) ?? notAfter })}
    </span>
  )
}
