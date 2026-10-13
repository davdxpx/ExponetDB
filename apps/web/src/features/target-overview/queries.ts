import type { Readable } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { type QueryLike, toReadable } from '../../lib/query/readable.ts'
import {
  findingsQuery,
  type HistoryRange,
  historyQuery,
  migrationStreamQuery,
  operationsQuery,
  targetMigrationsQuery,
} from './keys.ts'

/** One block's read: the truthful state, a way to read again and whether a read is running. */
export interface BlockRead<T> {
  readonly readable: Readable<T>
  readonly refetch: () => void
  readonly fetching: boolean
}

function block<T>(
  query: QueryLike<T> & { readonly isFetching: boolean; readonly refetch: () => unknown },
  missing?: (value: T) => readonly string[] | undefined,
): BlockRead<T> {
  return {
    readable: toReadable(query, missing === undefined ? {} : { missing }),
    refetch: () => void query.refetch(),
    fetching: query.isFetching,
  }
}

export type HealthHistory = ResponseOf<'getTargetHealthHistory'>
export type Findings = ResponseOf<'listTargetFindings'>
export type TargetMigrations = ResponseOf<'getTargetMigrations'>
export type MigrationStream = ResponseOf<'getMigrationStream'>
export type Operations = ResponseOf<'listOperations'>

export function useHealthHistory(
  path: string,
  range: HistoryRange,
  missing: (value: HealthHistory) => readonly string[] | undefined,
): BlockRead<HealthHistory> {
  const { client } = useApi()
  return block(useQuery(historyQuery(client, path, range)), missing)
}

export function useTargetFindings(
  path: string,
  missing: (value: Findings) => readonly string[] | undefined,
): BlockRead<Findings> {
  const { client } = useApi()
  return block(useQuery(findingsQuery(client, path)), missing)
}

export function useTargetMigrations(path: string): BlockRead<TargetMigrations> {
  const { client } = useApi()
  return block(useQuery(targetMigrationsQuery(client, path)))
}

export function useMigrationStream(
  projectId: string,
  missing: (value: MigrationStream) => readonly string[] | undefined,
): BlockRead<MigrationStream> {
  const { client } = useApi()
  return block(useQuery(migrationStreamQuery(client, projectId)), missing)
}

export function useTargetOperations(
  path: string,
  missing: (value: Operations) => readonly string[] | undefined,
): BlockRead<Operations> {
  const { client } = useApi()
  return block(useQuery(operationsQuery(client, path)), missing)
}
