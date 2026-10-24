import { Badge } from '@exponetdb/ui'
import { activeUntil, expiryStatus, formatRemaining, usePlanClock } from '@exponetdb/ui-data'
import { UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { withNodes } from '../../lib/i18n/with-nodes.tsx'
import { stateTextKey } from '../changes/model.ts'
import {
  clusterQuery,
  isClusterId,
  isNodeId,
  isServerId,
  nodeQuery,
  serverQuery,
} from '../infrastructure/keys.ts'
import { type SubjectNames, type TitleRefs, titleOf, titleSubjectKind } from './plan-title.ts'

/**
 * The head of the plan page and the operation page: the title that says what
 * happens (the kind in words and its subject, the subject's name as untrusted
 * text), the plan state as a badge, the expiry countdown and who created it
 * through which interface. The names of a server, a cluster or a node's
 * server are read from the registry once (no polling); until then, and when
 * the read fails, the title names the subject by its ID.
 */

/** The names a title needs, read once from the registry (servers, clusters, nodes). */
export function useSubjectNames(kind: string, refs: TitleRefs): SubjectNames {
  const { client } = useApi()
  const subject = titleSubjectKind(kind)
  const nodeRead = useQuery({
    ...nodeQuery(client, refs.nodeId ?? ''),
    enabled: subject === 'node' && isNodeId(refs.nodeId),
    refetchInterval: false,
  })
  const serverId =
    subject === 'server'
      ? refs.serverId
      : subject === 'node'
        ? (nodeRead.data?.serverId ?? null)
        : null
  const serverRead = useQuery({
    ...serverQuery(client, serverId ?? ''),
    enabled: isServerId(serverId),
    refetchInterval: false,
  })
  const clusterRead = useQuery({
    ...clusterQuery(client, refs.clusterId ?? ''),
    enabled: subject === 'cluster' && isClusterId(refs.clusterId),
    refetchInterval: false,
  })
  return {
    serverName: serverRead.data?.displayName,
    clusterName: clusterRead.data?.displayName,
  }
}

/** The title of a plan or operation of `kind`: a catalog sentence with its subject as text. */
export function KindTitle({
  kind,
  refs,
  migrationCount = null,
}: {
  readonly kind: string
  readonly refs: TitleRefs
  readonly migrationCount?: number | null
}): ReactNode {
  const names = useSubjectNames(kind, refs)
  const spec = titleOf(kind, refs, names, migrationCount)
  const subject =
    spec.subject === undefined ? undefined : spec.subject.kind === 'not_known' ? (
      <span className="text-foreground-lighter italic">{t('plans.subject.notKnown')}</span>
    ) : (
      <UntrustedName
        name={spec.subject.text}
        mono={spec.subject.kind === 'id'}
        label={t('plans.subject.label')}
        data-title-subject={spec.subject.kind}
      />
    )
  return (
    <span data-title-key={spec.key}>
      {withNodes(t(spec.key, spec.count === undefined ? {} : { count: spec.count }), {
        ...(subject === undefined ? {} : { subject }),
        ...(spec.kind === undefined
          ? {}
          : { kind: <UntrustedName name={spec.kind} mono label={t('changes.column.kind')} /> }),
      })}
    </span>
  )
}

const PLAN_STATES: Readonly<
  Record<
    string,
    {
      readonly key: MessageKey
      readonly variant: 'default' | 'success' | 'warning' | 'destructive'
    }
  >
> = {
  active: { key: 'plans.state.active', variant: 'success' },
  consumed: { key: 'plans.state.consumed', variant: 'default' },
  expired: { key: 'plans.state.expired', variant: 'warning' },
  invalidated: { key: 'plans.state.invalidated', variant: 'warning' },
  denied: { key: 'plans.state.denied', variant: 'destructive' },
  withdrawn: { key: 'plans.state.withdrawn', variant: 'default' },
}

/** The plan state as a badge; a state this version does not know is shown as its own marked text. */
export function PlanStateBadge({ state }: { readonly state: string }): ReactNode {
  const known = Object.hasOwn(PLAN_STATES, state) ? PLAN_STATES[state] : undefined
  return (
    <span data-plan-state={state} className="inline-flex items-center">
      <span className="sr-only">{`${t('plans.header.state')}: `}</span>
      {known === undefined ? (
        <Badge variant="default">
          <UntrustedName name={state} mono label={t('plans.header.state')} />
        </Badge>
      ) : (
        <Badge variant={known.variant}>{t(known.key)}</Badge>
      )}
    </span>
  )
}

const OPERATION_STATE_VARIANTS: Readonly<
  Record<string, 'default' | 'success' | 'warning' | 'destructive'>
> = {
  awaiting_approval: 'warning',
  needs_attention: 'warning',
  needs_reconciliation: 'warning',
  succeeded: 'success',
  failed: 'destructive',
  verification_failed: 'destructive',
}

/**
 * The state of an operation as a badge, in words ("Awaiting approval",
 * "Verifying", "Succeeded"); a state this version does not know is shown as
 * its own marked text. The plan page shows it for a used plan, whose own
 * state no longer says where the change stands.
 */
export function OperationStateBadge({ state }: { readonly state: string }): ReactNode {
  const key = stateTextKey(state)
  const variant = Object.hasOwn(OPERATION_STATE_VARIANTS, state)
    ? OPERATION_STATE_VARIANTS[state]
    : 'default'
  return (
    <span data-operation-state={state} className="inline-flex items-center">
      <span className="sr-only">{`${t('changes.header.state')}: `}</span>
      <Badge variant={variant}>
        <span data-state={state}>
          {key === undefined ? (
            <UntrustedName name={state} mono label={t('changes.header.state')} />
          ) : (
            t(key)
          )}
        </span>
      </Badge>
    </span>
  )
}

/**
 * "Expires in 14 min 33 s" while the plan is active (the device clock, every
 * second, not a live region), "Expired" once it is past; nothing for a plan
 * that was used, withdrawn or refused, whose expiry no longer matters. An
 * active plan that expires while the page is open is announced once.
 */
export function PlanExpiry({
  state,
  expiresAt,
}: {
  readonly state: string
  readonly expiresAt: string
}): ReactNode {
  const clock = usePlanClock(undefined, activeUntil(state, expiresAt))
  const expiry = expiryStatus(expiresAt, clock)
  const expired = state === 'expired' || (state === 'active' && expiry.kind === 'expired')
  const shown = expired ? (
    <span data-expiry="expired" className="font-medium text-destructive">
      {t('plans.header.expired')}
    </span>
  ) : state === 'active' && expiry.kind === 'open' ? (
    <span data-expiry="open">
      {t('plans.header.expiresIn', { time: formatRemaining(expiry.remainingMs) })}
    </span>
  ) : null
  if (state !== 'active') return shown
  return (
    <>
      {shown}
      {/* Stays in the page while empty, so the expiry is announced when it happens. */}
      <span role="status" className="sr-only">
        {expired ? t('plans.header.expiredNow') : ''}
      </span>
    </>
  )
}

const VIA: Readonly<Record<string, MessageKey>> = {
  web: 'approvals.via.web',
  rest: 'approvals.via.rest',
  mcp: 'approvals.via.mcp',
  cli: 'approvals.via.cli',
  ci: 'approvals.via.ci',
  system: 'approvals.via.system',
}

/** The keys of "Created by …" (a plan) or "Started by …" (an operation). */
export interface ActorWords {
  readonly you: MessageKey
  readonly person: MessageKey
  readonly service: MessageKey
  readonly system: MessageKey
}

export const PLAN_ACTOR_WORDS: ActorWords = {
  you: 'plans.header.byYou',
  person: 'plans.header.byPerson',
  service: 'plans.header.byService',
  system: 'plans.header.bySystem',
}

/**
 * Who acted and through which interface, in words: "Created by you via Web
 * App" for the signed-in person's own plan, "a person" or "a service
 * account" otherwise (the identity's ID is in the technical details, never
 * the main text), "ExponetDB itself" for the system.
 */
export function ActorLine({
  actor,
  meId,
  words,
}: {
  readonly actor: {
    readonly kind: string
    readonly identityId: string | null
    readonly via: string
  }
  readonly meId: string
  readonly words: ActorWords
}): ReactNode {
  if (actor.kind === 'system') return <span data-actor="system">{t(words.system)}</span>
  const key =
    actor.identityId !== null && actor.identityId === meId
      ? words.you
      : actor.kind === 'service'
        ? words.service
        : words.person
  const via = Object.hasOwn(VIA, actor.via) ? VIA[actor.via] : undefined
  return (
    <span data-actor={key === words.you ? 'you' : actor.kind}>
      {withNodes(t(key), {
        via:
          via === undefined ? (
            <UntrustedName name={actor.via} mono label={t('approvals.item.through')} />
          ) : (
            t(via)
          ),
      })}
    </span>
  )
}

/** The facts under the title, in one wrapping line. */
export function HeaderFacts({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      data-header-facts=""
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground-light"
    >
      {children}
    </div>
  )
}
