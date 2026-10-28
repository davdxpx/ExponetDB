import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { isTargetPath } from '../target/params.ts'
import { isClusterId, isProjectId, isReportId, isTargetId } from './ids.ts'

/**
 * Query keys and options of the target pages that read what the Control
 * Store keeps (migrations, findings, drift, activity, configuration). Every
 * query is disabled for an id that failed its grammar, so such an id never
 * reaches the server. The cache holds the server's answers as they came.
 */
export const opsKeys = {
  all: ['target-ops'] as const,
  ledger: (path: string) => ['target-ops', 'ledger', path] as const,
  stream: (projectId: string) => ['target-ops', 'stream', projectId] as const,
  plans: (targetId: string) => ['target-ops', 'plans', targetId] as const,
  driftFindings: (path: string) => ['target-ops', 'drift-findings', path] as const,
  driftChecks: (path: string) => ['target-ops', 'drift-checks', path] as const,
  findings: (path: string, filters: object) => ['target-ops', 'findings', path, filters] as const,
  report: (path: string, reportId: string) => ['target-ops', 'report', path, reportId] as const,
  operations: (targetId: string) => ['target-ops', 'operations', targetId] as const,
  audit: (targetId: string) => ['target-ops', 'audit', targetId] as const,
  policy: () => ['target-ops', 'policy'] as const,
  credentials: (clusterId: string) => ['target-ops', 'credentials', clusterId] as const,
}

/** How often an open page asks again. */
export const OPS_POLL_MS = 30_000
/** The most rows one list read of a target page asks for. */
export const OPS_PAGE_LIMIT = 50
/** The rows a summary list (plans, drift findings on the migrations page) asks for. */
export const OPS_SUMMARY_LIMIT = 10

export function ledgerQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: opsKeys.ledger(path),
    queryFn: ({ signal }) =>
      client.operation('getTargetMigrations', { params: { target: path }, signal }),
    enabled: isTargetPath(path),
    refetchInterval: OPS_POLL_MS,
  })
}

export function streamQuery(client: ApiClient, projectId: string) {
  return queryOptions({
    queryKey: opsKeys.stream(projectId),
    queryFn: ({ signal }) =>
      client.operation('getMigrationStream', { params: { projectId }, signal }),
    enabled: isProjectId(projectId),
    refetchInterval: OPS_POLL_MS,
  })
}

export function targetPlansQuery(client: ApiClient, targetId: string) {
  return queryOptions({
    queryKey: opsKeys.plans(targetId),
    queryFn: ({ signal }) =>
      client.operation('listPlans', {
        query: { target: targetId, limit: OPS_SUMMARY_LIMIT },
        signal,
      }),
    enabled: isTargetId(targetId),
    refetchInterval: OPS_POLL_MS,
  })
}

export function driftFindingsQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: opsKeys.driftFindings(path),
    queryFn: ({ signal }) =>
      client.operation('listTargetFindings', {
        params: { target: path },
        query: { kind: 'drift', limit: OPS_SUMMARY_LIMIT },
        signal,
      }),
    enabled: isTargetPath(path),
    refetchInterval: OPS_POLL_MS,
  })
}

/** The checks the drift page reads: the last one in full and the ones before it in a short history. */
export const DRIFT_HISTORY_LIMIT = 10

/**
 * The drift checks ExponetDB recorded for a target, newest first (scheduled
 * and run on demand): a read of the Control Store, no database is touched. The
 * first item is the last check. The findings of a check are not stored with it.
 */
export function driftChecksQuery(client: ApiClient, path: string) {
  return queryOptions({
    queryKey: opsKeys.driftChecks(path),
    queryFn: ({ signal }) =>
      client.operation('listDriftChecks', {
        params: { target: path },
        query: { limit: DRIFT_HISTORY_LIMIT },
        signal,
      }),
    enabled: isTargetPath(path),
    refetchInterval: OPS_POLL_MS,
  })
}

export function importReportQuery(client: ApiClient, path: string, reportId: string) {
  return queryOptions({
    queryKey: opsKeys.report(path, reportId),
    queryFn: ({ signal }) =>
      client.operation('getImportReport', {
        params: { target: path, importReportId: reportId },
        signal,
      }),
    enabled: isTargetPath(path) && isReportId(reportId),
  })
}

export interface FindingFilters {
  readonly severity?: 'info' | 'warning' | 'critical'
  readonly state: 'open' | 'resolved' | 'all'
  readonly kind?: 'drift' | 'health' | 'advisor' | 'statements'
}

/** Findings of one target, keyset pages by the server's opaque cursor. */
export function findingsQuery(client: ApiClient, path: string, filters: FindingFilters) {
  return infiniteQueryOptions({
    queryKey: opsKeys.findings(path, filters),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listFindings', {
        query: {
          target: path,
          state: filters.state,
          limit: OPS_PAGE_LIMIT,
          ...(filters.severity === undefined ? {} : { severity: filters.severity }),
          ...(filters.kind === undefined ? {} : { kind: filters.kind }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isTargetPath(path),
    refetchInterval: OPS_POLL_MS,
  })
}

export function operationsQuery(client: ApiClient, targetId: string) {
  return infiniteQueryOptions({
    queryKey: opsKeys.operations(targetId),
    queryFn: ({ signal, pageParam }) =>
      client.operation('listOperations', {
        query: {
          target: targetId,
          actor: 'any',
          limit: OPS_PAGE_LIMIT,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isTargetId(targetId),
    refetchInterval: OPS_POLL_MS,
  })
}

export function auditQuery(client: ApiClient, targetId: string) {
  return infiniteQueryOptions({
    queryKey: opsKeys.audit(targetId),
    queryFn: ({ signal, pageParam }) =>
      client.operation('searchAuditEvents', {
        query: {
          target: targetId,
          actor: 'any',
          limit: OPS_PAGE_LIMIT,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: isTargetId(targetId),
    refetchInterval: OPS_POLL_MS,
  })
}

export function policySettingsQuery(client: ApiClient) {
  return queryOptions({
    queryKey: opsKeys.policy(),
    queryFn: ({ signal }) => client.operation('getPolicySettings', { signal }),
    refetchInterval: OPS_POLL_MS,
  })
}

export function clusterCredentialsQuery(client: ApiClient, clusterId: string) {
  return queryOptions({
    queryKey: opsKeys.credentials(clusterId),
    queryFn: ({ signal }) =>
      client.operation('listClusterCredentials', { params: { clusterId }, signal }),
    enabled: isClusterId(clusterId),
    refetchInterval: OPS_POLL_MS,
  })
}
