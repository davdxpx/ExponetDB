import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { isTargetPath } from '../target/params.ts'
import { isProjectId } from '../target-ops/ids.ts'
import { type BundleFileName, isBundleFile, isMigrationId, isRevision } from './bundle-model.ts'

/**
 * Query keys and options of stored bundles (`GET /projects/{p}/bundles/…`)
 * and of one migration on a target (`GET /targets/{t}/migrations/{m}`).
 * Keys are built from validated values only and every query is disabled for
 * anything else, so an id that failed its grammar never reaches the server.
 * A stored revision never changes (bundles are append-only), so its files
 * are not read again while the panel is open; the target's events are.
 */
export const bundleKeys = {
  bundle: (projectId: string, migrationId: string) => ['bundles', projectId, migrationId] as const,
  file: (projectId: string, migrationId: string, revision: number, file: BundleFileName) =>
    ['bundles', projectId, migrationId, 'file', revision, file] as const,
  onTarget: (target: string, migrationId: string) =>
    ['bundles', 'target', target, migrationId] as const,
}

/** How often the panel reads the target's events and verification runs again. */
export const TARGET_MIGRATION_POLL_MS = 30_000

export function bundleQuery(client: ApiClient, projectId: string, migrationId: string) {
  return queryOptions({
    queryKey: bundleKeys.bundle(projectId, migrationId),
    queryFn: ({ signal }) =>
      client.operation('getBundle', { params: { projectId, migrationId }, signal }),
    enabled: isProjectId(projectId) && isMigrationId(migrationId),
  })
}

export function bundleFileQuery(
  client: ApiClient,
  projectId: string,
  migrationId: string,
  revision: number,
  file: BundleFileName,
  enabled = true,
) {
  return queryOptions({
    queryKey: bundleKeys.file(projectId, migrationId, revision, file),
    queryFn: ({ signal }) =>
      client.operation('getBundleFile', {
        params: { projectId, migrationId, revision, file },
        signal,
      }),
    enabled:
      enabled &&
      isProjectId(projectId) &&
      isMigrationId(migrationId) &&
      isRevision(revision) &&
      isBundleFile(file),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function targetMigrationQuery(client: ApiClient, target: string, migrationId: string) {
  return queryOptions({
    queryKey: bundleKeys.onTarget(target, migrationId),
    queryFn: ({ signal }) =>
      client.operation('getTargetMigration', { params: { target, migrationId }, signal }),
    enabled: isTargetPath(target) && isMigrationId(migrationId),
    refetchInterval: TARGET_MIGRATION_POLL_MS,
  })
}
