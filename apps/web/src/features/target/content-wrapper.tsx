import {
  Admonition,
  LoadingState,
  NotAvailableYetState,
  NotPermittedState,
  type Readable,
  ReadableView,
  StaleBanner,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import type { Requirement } from '../../shell/navigation.ts'
import { type Gate, gateFor, permissionsRequired } from './gate.ts'
import {
  CannotTellState,
  DecommissionedState,
  NodeOfflineState,
  NoNodeState,
  SuspendedState,
  UnreachableState,
} from './named-states.tsx'
import { nounPhrase } from './phrases.ts'
import type { Target, TargetHealth } from './queries.ts'

/**
 * The status gate of a target page (order section 7, "App shell"): it renders
 * a named state instead of a broken page. The first state that holds wins,
 * else the children:
 *
 * 1. the target read is loading: a loading region;
 * 2. the target read failed: the failed read with a retry (never "not
 *    found", never empty; "not found" is the layout's answer to the server's
 *    `NOT_FOUND`);
 * 3. the target is decommissioned; 4. the target is suspended;
 * 5. the page waits for Wave 9; 6. the page waits for decision OD-21;
 * 7. a permission the person lacks (the server still decides; this only
 *    avoids a broken page);
 * 8. `target.reachable`: unreachable, or "cannot tell" when health is
 *    unknown, failed or missing (never "healthy", never the page with
 *    empty data);
 * 9. `node.online`: the node is not online, or "cannot tell".
 *
 * A stale target read keeps its value under a banner; so does a stale health
 * read that does not change the answer. Every state has a heading, one
 * sentence and, where it helps, one next action; the text is in the catalog.
 */
export interface ContentWrapperProps {
  /** What the page needs (`TARGET_NAV[...].requires`). */
  readonly requires: readonly Requirement[]
  /** The read of the target (`useTarget`). */
  readonly target: Readable<Target>
  /** The read of the target's health; needed when `requires` names `target.reachable` or `node.online`. */
  readonly health?: Readable<TargetHealth>
  /** The page, as a noun phrase that starts a sentence ("Performance"). Default "This page". */
  readonly feature?: string
  /** Reads the target again (failed and stale states). */
  readonly onRetry?: () => void
  /** Reads the health again. */
  readonly onRetryHealth?: () => void
  /** A read of the target is running. */
  readonly busy?: boolean
  readonly children: ReactNode
}

export function ContentWrapper(props: ContentWrapperProps): ReactNode {
  const needsPermissions = permissionsRequired(props.requires).length > 0
  return (
    <ReadableView
      readable={props.target}
      what={nounPhrase('target.read.what')}
      onRetry={props.onRetry}
      onRefresh={props.onRetry}
      busy={props.busy}
      headingLevel={2}
      ready={(target) =>
        needsPermissions ? (
          <WithPermissions>
            {(permissions) => <Gated {...props} target={target} permissions={permissions} />}
          </WithPermissions>
        ) : (
          <Gated {...props} target={target} permissions={undefined} />
        )
      }
    />
  )
}

/** Reads the person's permissions only for a page that names one, so other pages need no session. */
function WithPermissions(props: {
  readonly children: (permissions: readonly string[]) => ReactNode
}): ReactNode {
  const me = useMe()
  return props.children(me.effectivePermissions.map((entry) => entry.permission))
}

interface GatedProps extends Omit<ContentWrapperProps, 'target'> {
  readonly target: Target
  readonly permissions: readonly string[] | undefined
}

function Gated(props: GatedProps): ReactNode {
  const gate = gateFor({
    requires: props.requires,
    target: props.target,
    health: props.health,
    permissions: props.permissions,
  })
  const feature = props.feature ?? t('target.feature.default')
  return (
    <GateView
      gate={gate}
      feature={feature}
      onRetryHealth={props.onRetryHealth}
      page={props.children}
    />
  )
}

function GateView(props: {
  readonly gate: Gate
  readonly feature: string
  readonly onRetryHealth: (() => void) | undefined
  /** The page itself, shown when the gate is open. */
  readonly page: ReactNode
}): ReactNode {
  const { gate, feature, onRetryHealth } = props
  switch (gate.kind) {
    case 'open':
      return (
        <>
          {gate.lifecycle === undefined ? null : (
            <Admonition
              type="warning"
              title={t(`target.state.${gate.lifecycle}.title`)}
              description={t(`target.state.${gate.lifecycle}.body`)}
              className="mb-3"
            />
          )}
          {gate.staleHealth === undefined ? null : (
            <StaleBanner
              what={nounPhrase('target.health.what')}
              source={gate.staleHealth.source}
              observedAt={gate.staleHealth.observedAt}
              error={gate.staleHealth.error}
              onRefresh={onRetryHealth}
              className="mb-3"
            />
          )}
          {props.page}
        </>
      )
    case 'decommissioned':
      return <DecommissionedState />
    case 'suspended':
      return <SuspendedState />
    case 'wave9':
      return (
        <NotAvailableYetState
          what={feature}
          reason={t('target.state.wave9.reason')}
          headingLevel={2}
        />
      )
    case 'od21':
      return (
        <NotAvailableYetState
          what={feature}
          reason={t('target.state.od21.reason')}
          headingLevel={2}
        />
      )
    case 'not_permitted':
      return (
        <NotPermittedState
          what={nounPhrase('target.state.permission.what')}
          permission={gate.permission}
          headingLevel={2}
        />
      )
    case 'health_loading':
      return <LoadingState what={nounPhrase('target.health.what')} />
    case 'unreachable':
      return <UnreachableState health={gate.health} onRetry={onRetryHealth} />
    case 'target_cannot_tell':
      return <CannotTellState subject="target" cause={gate.cause} onRetry={onRetryHealth} />
    case 'node_offline':
      return <NodeOfflineState node={gate.node} onRetry={onRetryHealth} />
    case 'node_cannot_tell':
      return <CannotTellState subject="node" cause={gate.cause} onRetry={onRetryHealth} />
    case 'no_node':
      return <NoNodeState feature={feature} />
  }
}
