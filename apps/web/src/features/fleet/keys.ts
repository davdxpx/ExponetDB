import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'

/**
 * Query keys and options of the fleet overview: the fleet counts, the newest
 * open critical findings and the Control Plane health. Each is one request;
 * none depends on the number of targets.
 */
export const fleetKeys = {
  fleet: ['fleet', 'counts'] as const,
  critical: ['fleet', 'critical-findings'] as const,
  controlPlane: ['fleet', 'control-plane'] as const,
  work: ['fleet', 'needs-attention'] as const,
}

/** How often the overview asks again. */
export const FLEET_POLL_MS = 30_000
/** The critical findings the overview lists. */
export const CRITICAL_LIMIT = 5
/** A part counted longer ago than this shows as stale. */
export const PART_STALE_AFTER_MS = 120_000

export function fleetQuery(client: ApiClient) {
  return queryOptions({
    queryKey: fleetKeys.fleet,
    queryFn: ({ signal }) => client.operation('getFleet', { signal }),
    refetchInterval: FLEET_POLL_MS,
  })
}

export function criticalFindingsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: fleetKeys.critical,
    queryFn: ({ signal }) =>
      client.operation('listFindings', {
        query: { severity: 'critical', state: 'open', limit: CRITICAL_LIMIT },
        signal,
      }),
    refetchInterval: FLEET_POLL_MS,
  })
}

export function controlPlaneQuery(client: ApiClient) {
  return queryOptions({
    queryKey: fleetKeys.controlPlane,
    queryFn: ({ signal }) => client.operation('getInstallationHealth', { signal }),
    refetchInterval: FLEET_POLL_MS,
  })
}
