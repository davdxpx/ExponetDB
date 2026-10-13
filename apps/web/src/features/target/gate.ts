import type { Readable, ReadFailure, ReadSource } from '@exponetdb/ui-patterns'
import type { Requirement } from '../../shell/navigation.ts'
import type { Target, TargetHealth } from './queries.ts'

/**
 * What a target page may show, decided from its requirements and what is
 * known about the target (information-architecture.md section 3: "the shell
 * renders a named state instead of a broken page"). The decision is a pure
 * function, so every state is a table test; `ContentWrapper` only renders it.
 *
 * Order, the first that holds wins: the target is decommissioned or
 * suspended and the page shows live target data (it needs the target, its
 * node, or the Wave 9 parts); the page waits
 * for Wave 9; the page waits for decision OD-21;
 * a permission the person lacks; the target is unreachable (or health cannot
 * tell); the node is not online (or health cannot tell). Nothing that could
 * not be observed is ever treated as healthy. A page that reads only what
 * the Control Store keeps (activity, findings, drift, migrations, settings)
 * stays readable on a suspended or decommissioned target, under a notice:
 * it is where a person looks up why.
 */
export type NodeOf = NonNullable<TargetHealth['node']>

/** Why a state is "cannot tell" instead of "yes" or "no". */
export type CannotTell =
  | { readonly kind: 'failed'; readonly error: ReadFailure }
  | {
      readonly kind: 'unknown'
      readonly source: string
      readonly observedAt: string
      /** `unknownBecause` of the health answer (a machine word), or `null`. */
      readonly reason: string | null
    }
  | { readonly kind: 'missing' }

/** A health read that is older than it should be: the page shows it under a banner. */
export interface StaleHealth {
  readonly source: ReadSource
  readonly observedAt: string
  readonly error?: ReadFailure
}

export type Gate =
  | {
      readonly kind: 'open'
      readonly staleHealth?: StaleHealth
      /** The page is readable, but the target is no longer managed normally: shown as a notice. */
      readonly lifecycle?: 'suspended' | 'decommissioned'
    }
  | { readonly kind: 'decommissioned' }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'wave9' }
  | { readonly kind: 'od21' }
  | { readonly kind: 'not_permitted'; readonly permission: string }
  | { readonly kind: 'health_loading' }
  | { readonly kind: 'unreachable'; readonly health: TargetHealth }
  | { readonly kind: 'target_cannot_tell'; readonly cause: CannotTell }
  | { readonly kind: 'node_offline'; readonly node: NodeOf }
  | { readonly kind: 'node_cannot_tell'; readonly cause: CannotTell }
  | { readonly kind: 'no_node' }

export interface GateInput {
  readonly requires: readonly Requirement[]
  readonly target: Target
  /** The health read, when the page has one. A page that needs health and has none cannot tell. */
  readonly health: Readable<TargetHealth> | undefined
  /** The permissions of the signed-in person; needed only when `requires` names a permission. */
  readonly permissions: readonly string[] | undefined
}

const SOURCES: readonly ReadSource[] = ['live', 'sampled', 'cached', 'agent_reported', 'inferred']

/** The read source a server word names, or `undefined` for a word this page does not know. */
export function readSourceOf(source: string): ReadSource | undefined {
  return SOURCES.find((candidate) => candidate === source)
}

const PERMISSION_PREFIX = 'permission:'

export function permissionOf(requirement: Requirement): string | undefined {
  return requirement.startsWith(PERMISSION_PREFIX)
    ? requirement.slice(PERMISSION_PREFIX.length)
    : undefined
}

/** The permissions a requirement list names, in order. */
export function permissionsRequired(requires: readonly Requirement[]): readonly string[] {
  return requires.flatMap((requirement) => {
    const permission = permissionOf(requirement)
    return permission === undefined ? [] : [permission]
  })
}

/** Node states in which the agent is alive and reachable by ExponetDB. */
const NODE_ONLINE: ReadonlySet<NodeOf['state']> = new Set(['active', 'degraded'])

type HealthOutcome =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly error: ReadFailure }
  | { readonly kind: 'value'; readonly health: TargetHealth; readonly stale?: StaleHealth }

function outcomeOf(health: Readable<TargetHealth>): HealthOutcome {
  switch (health.state) {
    case 'loading':
      return { kind: 'loading' }
    case 'failed':
      return { kind: 'failed', error: health.error }
    case 'stale':
      return {
        kind: 'value',
        health: health.value,
        stale: {
          source: health.source,
          observedAt: health.observedAt,
          ...(health.error === undefined ? {} : { error: health.error }),
        },
      }
    case 'partial':
    case 'ready':
      return { kind: 'value', health: health.value }
    default:
      // A state this page does not know is a read that failed, never a healthy one.
      return {
        kind: 'failed',
        error: { code: 'UNKNOWN', message: 'The state of this read was not recognized.' },
      }
  }
}

function openWith(stale: StaleHealth | undefined): Gate {
  return stale === undefined ? { kind: 'open' } : { kind: 'open', staleHealth: stale }
}

export function gateFor(input: GateInput): Gate {
  const { requires, target, health, permissions } = input
  const needsTarget = requires.includes('target.reachable')
  const needsNode = requires.includes('node.online')
  const lifecycle =
    target.state === 'decommissioned' || target.state === 'suspended' ? target.state : undefined
  // Pages of live target data (health, node, the Wave 9 pages) say what happened to the target.
  const live = needsTarget || needsNode || requires.includes('wave9')
  if (lifecycle !== undefined && live) return { kind: lifecycle }
  if (requires.includes('wave9')) return { kind: 'wave9' }
  if (requires.includes('od21')) return { kind: 'od21' }
  for (const permission of permissionsRequired(requires)) {
    if (permissions === undefined || !permissions.includes(permission)) {
      return { kind: 'not_permitted', permission }
    }
  }

  if (!needsTarget && !needsNode) {
    return lifecycle === undefined ? { kind: 'open' } : { kind: 'open', lifecycle }
  }

  if (health === undefined) {
    const cause: CannotTell = { kind: 'missing' }
    return needsTarget ? { kind: 'target_cannot_tell', cause } : { kind: 'node_cannot_tell', cause }
  }
  const outcome = outcomeOf(health)
  if (outcome.kind === 'loading') return { kind: 'health_loading' }
  if (outcome.kind === 'failed') {
    const cause: CannotTell = { kind: 'failed', error: outcome.error }
    return needsTarget ? { kind: 'target_cannot_tell', cause } : { kind: 'node_cannot_tell', cause }
  }
  const value = outcome.health

  if (needsTarget) {
    switch (value.state) {
      case 'unreachable':
        return { kind: 'unreachable', health: value }
      case 'suspended':
        // The identity check failed or the target was suspended since the page read it.
        return { kind: 'suspended' }
      case 'unknown':
        return {
          kind: 'target_cannot_tell',
          cause: {
            kind: 'unknown',
            source: value.source,
            observedAt: value.observedAt,
            reason: value.unknownBecause,
          },
        }
      case 'healthy':
      case 'degraded':
      case 'unhealthy':
        break
    }
  }

  if (needsNode) {
    const node = value.node
    if (node === null) return { kind: 'no_node' }
    if (node.state === 'unknown') {
      return {
        kind: 'node_cannot_tell',
        cause: { kind: 'unknown', source: node.source, observedAt: node.observedAt, reason: null },
      }
    }
    if (!NODE_ONLINE.has(node.state)) return { kind: 'node_offline', node }
  }
  return openWith(outcome.stale)
}
