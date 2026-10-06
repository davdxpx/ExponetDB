import { readMarker, type TargetSession } from '@exponetdb/postgres'
import type { TargetRecord } from '@exponetdb/registry'
import { DiagnosticsError } from './errors.ts'
import type { IdentitySample } from './reducer.ts'

/**
 * The identity check of a target session (C-27, health.md §2 `identity`,
 * order §130): the marker in the database must name exactly this
 * installation, this target, its current generation and the cluster's
 * pinned `system_identifier`, and the session must have reached that
 * cluster. Anything else is a mismatch; nothing is ever re-stamped here.
 */
export async function checkIdentity(
  session: TargetSession,
  target: TargetRecord,
  installationId: string,
): Promise<IdentitySample> {
  const pinned = target.placement?.systemIdentifier ?? null
  if (pinned === null || session.facts.systemIdentifier !== pinned) {
    return { status: 'mismatch', field: 'system_identifier' }
  }
  const marker = await readMarker(session)
  if (marker.status === 'absent') return { status: 'absent' }
  if (marker.status === 'unreadable') return { status: 'unreadable' }
  const m = marker.marker
  if (m.installationId !== installationId) return { status: 'mismatch', field: 'installation' }
  if (m.targetId !== target.targetId) return { status: 'mismatch', field: 'target' }
  if (m.generation !== target.generation) return { status: 'mismatch', field: 'generation' }
  if (m.clusterSystemId !== pinned) return { status: 'mismatch', field: 'system_identifier' }
  return { status: 'match' }
}

/** The field a failed identity check names (for findings and refusals). */
export function mismatchField(identity: IdentitySample): string {
  switch (identity.status) {
    case 'mismatch':
      return identity.field
    case 'absent':
      return 'marker_absent'
    case 'unreadable':
      return 'marker_unreadable'
    default:
      return 'unknown'
  }
}

/** Refuses a read whose session does not reach the registered target. */
export async function requireIdentity(
  session: TargetSession,
  target: TargetRecord,
  installationId: string,
): Promise<void> {
  const identity = await checkIdentity(session, target, installationId)
  if (identity.status !== 'match') {
    throw new DiagnosticsError('TARGET_IDENTITY_MISMATCH')
  }
}
