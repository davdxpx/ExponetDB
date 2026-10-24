import { queryOptions } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { isTargetPath } from '../target/params.ts'

/**
 * The schema comparison of two targets (`POST /schema-diffs`, a read: the
 * action class is `read` and nothing is written). The key is built from two
 * validated target paths; the query is disabled for anything else and for a
 * target compared with itself. The page asks again only when the person
 * refreshes: every comparison reads both targets.
 */
export const compareKeys = {
  diff: (left: string, right: string) => ['schema-diff', left, right] as const,
}

export function schemaDiffQuery(client: ApiClient, left: string, right: string) {
  return queryOptions({
    queryKey: compareKeys.diff(left, right),
    queryFn: ({ signal }) =>
      client.operation('createSchemaDiff', {
        body: { left: { target: left }, right: { target: right } },
        signal,
      }),
    enabled: isTargetPath(left) && isTargetPath(right) && left !== right,
    // A comparison reads both targets: a failure is shown with "Try again" at once, not retried.
    retry: false,
    refetchOnWindowFocus: false,
  })
}

/** After this long a comparison on the page counts as an earlier read (age shown, refresh offered). */
export const DIFF_STALE_AFTER_MS = 5 * 60_000
