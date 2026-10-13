import { CircleHelp, Server, ShieldAlert, Unlink } from '@exponetdb/icons'
import { Button } from '@exponetdb/ui'
import { ObservedTime, StateMessage, sourcePhrase, useLinkComponent } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { type CannotTell, type NodeOf, readSourceOf } from './gate.ts'
import type { TargetHealth } from './queries.ts'

/**
 * The named states of a target page (information-architecture.md section 3):
 * decommissioned, suspended, unreachable, "cannot tell" and node not online.
 * Each is a heading, one sentence and, where it helps, one next action. The
 * states that report an observation say where it came from and how old it is
 * (C-28); none of them shows data, an empty list or a healthy badge. All text
 * is in the message catalog.
 */
const HEADING_LEVEL = 2
const ICON = 'size-5 text-foreground-light'
const LINK = 'text-sm text-foreground underline'

/** "Source: live. Observed 4 min ago (2026-10-13 14:03 UTC)." */
function Observation(props: { readonly source: string; readonly observedAt: string }): ReactNode {
  const known = readSourceOf(props.source)
  return (
    <p>
      {known === undefined
        ? t('target.state.observationNoSource')
        : t('target.state.observation', { source: sourcePhrase(known) })}{' '}
      <ObservedTime observedAt={props.observedAt} withDate />.
    </p>
  )
}

function RetryHealth(props: { readonly onRetry: (() => void) | undefined }): ReactNode {
  if (props.onRetry === undefined) return null
  return (
    <Button type="button" size="tiny" variant="outline" onClick={props.onRetry}>
      {t('target.state.readHealth')}
    </Button>
  )
}

export function DecommissionedState(): ReactNode {
  const Link = useLinkComponent()
  return (
    <StateMessage
      data-state="decommissioned"
      icon={<Unlink aria-hidden className={ICON} />}
      title={t('target.state.decommissioned.title')}
      headingLevel={HEADING_LEVEL}
      actions={
        <Link href="/targets" className={LINK}>
          {t('target.state.decommissioned.action')}
        </Link>
      }
    >
      <p>{t('target.state.decommissioned.body')}</p>
    </StateMessage>
  )
}

export function SuspendedState(): ReactNode {
  const Link = useLinkComponent()
  return (
    <StateMessage
      data-state="suspended"
      icon={<ShieldAlert aria-hidden className={ICON} />}
      title={t('target.state.suspended.title')}
      headingLevel={HEADING_LEVEL}
      actions={
        <Link href="/audit" className={LINK}>
          {t('target.state.suspended.action')}
        </Link>
      }
    >
      <p>{t('target.state.suspended.body')}</p>
    </StateMessage>
  )
}

/** What the node's state adds to an unreachable target (health.md section 1, "distinctions that must always be visible"). */
function NodeNuance(props: { readonly node: TargetHealth['node'] }): ReactNode {
  const node = props.node
  if (node === null) return <p>{t('target.state.unreachable.noNode')}</p>
  if (node.state === 'active' || node.state === 'degraded') {
    return <p>{t('target.state.unreachable.nodeAlive')}</p>
  }
  if (node.state === 'unknown') return null
  return <p>{t('target.state.unreachable.nodeDown')}</p>
}

export function UnreachableState(props: {
  readonly health: TargetHealth
  readonly onRetry?: () => void
}): ReactNode {
  const { health, onRetry } = props
  return (
    <StateMessage
      data-state="unreachable"
      icon={<Unlink aria-hidden className={ICON} />}
      title={t('target.state.unreachable.title')}
      headingLevel={HEADING_LEVEL}
      actions={<RetryHealth onRetry={onRetry} />}
    >
      <p>{t('target.state.unreachable.body')}</p>
      <Observation source={health.source} observedAt={health.observedAt} />
      <NodeNuance node={health.node} />
    </StateMessage>
  )
}

const UNKNOWN_REASONS: ReadonlyMap<string, MessageKey> = new Map([
  ['control_plane_degraded', 'target.unknown.control_plane_degraded'],
  ['never_sampled', 'target.unknown.never_sampled'],
  ['sampler_lagging', 'target.unknown.sampler_lagging'],
  ['no_endpoint', 'target.unknown.no_endpoint'],
  ['no_placement', 'target.unknown.no_placement'],
  ['observer_credential_missing', 'target.unknown.observer_credential_missing'],
  ['no_active_endpoint', 'target.unknown.no_active_endpoint'],
])

/** The reason `unknownBecause` names, in words. A word this page does not know is shown as the word it is. */
function unknownReason(reason: string | null): string {
  if (reason === null) return t('target.unknown.none')
  const key = UNKNOWN_REASONS.get(reason)
  return key === undefined ? t('target.unknown.other', { code: reason }) : t(key)
}

function failedReason(cause: Extract<CannotTell, { kind: 'failed' }>): string {
  return t('error.withCode', { message: cause.error.message, code: cause.error.code })
}

/**
 * "Cannot tell whether the target is reachable" (or whether the node is
 * online): the health read failed, never arrived, or says unknown. This is
 * not "healthy", "unreachable" or an empty page; the sentence says what is
 * missing and that the thing itself may be fine.
 */
export function CannotTellState(props: {
  readonly subject: 'target' | 'node'
  readonly cause: CannotTell
  readonly onRetry?: () => void
}): ReactNode {
  const { subject, cause, onRetry } = props
  const node = subject === 'node'
  let body: ReactNode
  switch (cause.kind) {
    case 'failed':
      body = (
        <p>
          {t(node ? 'target.state.nodeCannotTell.failed' : 'target.state.cannotTell.failed', {
            reason: failedReason(cause),
          })}
        </p>
      )
      break
    case 'missing':
      body = (
        <p>{t(node ? 'target.state.nodeCannotTell.missing' : 'target.state.cannotTell.missing')}</p>
      )
      break
    case 'unknown':
      body = (
        <>
          <p>
            {node ? t('target.state.nodeCannotTell.unknown') : t('target.state.cannotTell.unknown')}
          </p>
          {node ? null : <p>{unknownReason(cause.reason)}</p>}
          <Observation source={cause.source} observedAt={cause.observedAt} />
        </>
      )
      break
  }
  return (
    <StateMessage
      data-state="cannot-tell"
      data-subject={subject}
      icon={<CircleHelp aria-hidden className={ICON} />}
      title={t(node ? 'target.state.nodeCannotTell.title' : 'target.state.cannotTell.title')}
      headingLevel={HEADING_LEVEL}
      actions={<RetryHealth onRetry={onRetry} />}
    >
      {body}
    </StateMessage>
  )
}

export function NodeOfflineState(props: {
  readonly node: NodeOf
  readonly onRetry?: () => void
}): ReactNode {
  const { node, onRetry } = props
  return (
    <StateMessage
      data-state="node-offline"
      icon={<Server aria-hidden className={ICON} />}
      title={t('target.state.nodeOffline.title')}
      headingLevel={HEADING_LEVEL}
      actions={<RetryHealth onRetry={onRetry} />}
    >
      <p>{t('target.state.nodeOffline.body', { state: node.state.replaceAll('_', ' ') })}</p>
      <Observation source={node.source} observedAt={node.observedAt} />
    </StateMessage>
  )
}

/**
 * The page needs a node agent and the target's cluster has none (health
 * reports no node for a cluster managed outside ExponetDB): a fact about the
 * target, not an error and not an empty page.
 */
export function NoNodeState(props: { readonly feature: string }): ReactNode {
  return (
    <StateMessage
      data-state="not-supported"
      icon={<Server aria-hidden className={ICON} />}
      title={t('target.state.noNode.title')}
      headingLevel={HEADING_LEVEL}
    >
      <p>{t('target.state.noNode.body', { feature: props.feature })}</p>
    </StateMessage>
  )
}
