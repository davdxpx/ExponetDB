import { LoadingState, ReadableView } from '@exponetdb/ui-patterns'
import { lazy, type ReactNode, Suspense } from 'react'

import type { ReadableTextDiffProps } from './diff-types.ts'

/**
 * The text diff viewer behind a `Readable` (C-28): this module is light and
 * loads the viewer (`text-diff.tsx`, CodeMirror's merge view) the first time
 * a read has a value to show. A failed read renders the failure only, never
 * an empty comparison or "No differences".
 */
const LazyTextDiffView = lazy(async () => ({
  default: (await import('./text-diff.tsx')).TextDiffView,
}))

export function ReadableTextDiff({
  readable,
  what,
  onRetry,
  onRefresh,
  busy,
  now,
  ...view
}: ReadableTextDiffProps): ReactNode {
  return (
    <ReadableView
      readable={readable}
      what={what}
      onRetry={onRetry}
      onRefresh={onRefresh}
      busy={busy}
      now={now}
      ready={(value) => (
        <Suspense fallback={<LoadingState what="the comparison" />}>
          <LazyTextDiffView {...view} before={value.before} after={value.after} />
        </Suspense>
      )}
    />
  )
}
