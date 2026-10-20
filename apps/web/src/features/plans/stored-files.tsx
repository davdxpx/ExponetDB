import type { ApprovalReview, MigrationBundle } from '@exponetdb/sdk/operations'
import { RawPlanTextBlock } from '@exponetdb/ui-data'
import {
  FailedReadState,
  LoadingState,
  PartialBanner,
  type Readable,
  readableValue,
} from '@exponetdb/ui-patterns'
import { useQueries } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { bundleFileQuery, bundleQuery } from '../migrations/bundle-keys.ts'
import {
  type BundleFileName,
  isMigrationId,
  isRevision,
  shownText,
} from '../migrations/bundle-model.ts'
import { isProjectId } from '../target-ops/ids.ts'
import { filesOf, type PlanFiles, type PlanSource } from './plan-model.ts'

/**
 * The files a migration plan runs, for every reader of the plan: the
 * approvals queue carries them only for an approver while an operation
 * waits, so the page reads them from the bundle store otherwise (`GET
 * /projects/{p}/bundles/{m}` to find the plan's revision by its digest, then
 * `…/revisions/{r}/files/{f}` for each file the kind runs). A revision whose
 * digest differs from the one the plan binds is not shown (it is not what the
 * plan runs). Files are text only, through the same raw-text block as the
 * queue's; what could not be read is named, never left out silently.
 */
type Json = Record<string, unknown>
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** The files each migration kind runs, in the order the server lists them (`REVIEW_FILES`). */
export const PLAN_FILES: Readonly<Record<string, readonly BundleFileName[]>> = {
  'migration.apply': ['up.sql', 'verify.sql'],
  'migration.resume': ['up.sql', 'verify.sql'],
  'migration.rollback': ['down.sql'],
  'migration.verify': ['verify.sql'],
}

/** The most bundles whose files the page reads (the review's limit). */
const MAX_BUNDLES = 64

/** One bundle a migration plan names: its id, name, revision and the bundle digest it binds. */
export interface PlanBundleItem {
  readonly migrationId: string
  /** Untrusted: the bundle's name as the plan stores it. */
  readonly name: string | null
  readonly revision: number | null
  readonly bundleDigest: string | null
}

/** The bundles of a migration plan (`content.projectId` and `content.migrations`), or `undefined`. */
export function planBundlesOf(
  plan: Pick<PlanSource, 'kind' | 'change'>,
): { readonly projectId: string; readonly items: readonly PlanBundleItem[] } | undefined {
  if (!plan.kind.startsWith('migration.') || plan.change === undefined) return undefined
  const content = obj(plan.change.content)
  const projectId = content['projectId']
  if (!isProjectId(projectId)) return undefined
  // A verification run names one migration; the other kinds list theirs.
  const listed = plan.kind === 'migration.verify' ? [content] : content['migrations']
  if (!Array.isArray(listed)) return undefined
  const items: PlanBundleItem[] = []
  for (const raw of listed) {
    const item = obj(raw)
    const migrationId = item['migrationId']
    if (!isMigrationId(migrationId)) continue
    const revision = item['revision']
    items.push({
      migrationId,
      name: str(item['name']),
      revision: isRevision(revision) ? revision : null,
      bundleDigest: str(item['bundleDigest']),
    })
  }
  return { projectId, items }
}

/**
 * The stored revision the plan runs: the plan's revision number when it is
 * given, checked against the plan's bundle digest when that is given too;
 * without a number, the revision with that digest. `undefined` when nothing
 * matches (the plan's content is then not shown from the store).
 */
export function matchRevision(stored: MigrationBundle, item: PlanBundleItem): number | undefined {
  if (item.revision === null && item.bundleDigest === null) return undefined
  return stored.revisions.find(
    (revision) =>
      (item.revision === null || revision.revision === item.revision) &&
      (item.bundleDigest === null || revision.bundleDigest === item.bundleDigest),
  )?.revision
}

interface FileJob {
  readonly item: PlanBundleItem
  readonly revision: number
  readonly file: BundleFileName
  readonly stored: boolean
}

/**
 * Reads the files of a migration plan from the bundle store, as the raw-text
 * block's data; `undefined` when there is nothing to read this way (not
 * enabled, a kind that runs no bundle file, content that names no project).
 */
export function useStoredFiles(
  plan: PlanSource,
  enabled: boolean,
): Readable<PlanFiles> | undefined {
  const { client } = useApi()
  const files = Object.hasOwn(PLAN_FILES, plan.kind) ? (PLAN_FILES[plan.kind] ?? []) : undefined
  const bundles = enabled && files !== undefined ? planBundlesOf(plan) : undefined
  const items = (bundles?.items ?? []).slice(0, MAX_BUNDLES)
  const projectId = bundles?.projectId ?? ''
  const stored = useQueries({
    queries: items.map((item) => bundleQuery(client, projectId, item.migrationId)),
  })
  const jobs: FileJob[] = []
  const missing: string[] = []
  let firstError: unknown
  let loading = false
  items.forEach((item, index) => {
    const read = stored[index]
    if (read === undefined || read.data === undefined) {
      if (read?.isError === true) {
        firstError ??= read.error
        missing.push(
          t('plans.files.bundleFailed', {
            migration: item.migrationId,
            reason: classifyFailure(read.error).code,
          }),
        )
      } else {
        loading = true
      }
      return
    }
    const revision = matchRevision(read.data, item)
    if (revision === undefined) {
      missing.push(t('plans.files.noMatch', { migration: item.migrationId }))
      return
    }
    const kept = read.data.revisions.find((r) => r.revision === revision)
    for (const file of files ?? []) {
      jobs.push({
        item,
        revision,
        file,
        stored: kept !== undefined && Object.hasOwn(kept.files, file),
      })
    }
  })
  const reads = useQueries({
    queries: jobs.map((job) =>
      bundleFileQuery(client, projectId, job.item.migrationId, job.revision, job.file, job.stored),
    ),
  })
  if (bundles === undefined) return undefined
  const sources: ApprovalReview['sources'][number][] = []
  jobs.forEach((job, index) => {
    if (!job.stored) {
      missing.push(
        t('plans.files.notStored', {
          file: job.file,
          migration: job.item.migrationId,
          revision: job.revision,
        }),
      )
      return
    }
    const read = reads[index]
    if (read?.data !== undefined) {
      const shown = shownText(read.data.text)
      sources.push({
        migrationId: job.item.migrationId,
        revision: job.revision,
        file: job.file,
        text: shown.text,
        bytes: read.data.bytes,
        truncated: shown.truncated,
      })
    } else if (read?.isError === true) {
      firstError ??= read.error
      missing.push(
        t('plans.files.fileFailed', {
          file: job.file,
          migration: job.item.migrationId,
          reason: classifyFailure(read.error).code,
        }),
      )
    } else {
      loading = true
    }
  })
  if (bundles.items.length > MAX_BUNDLES) {
    missing.push(t('plans.files.tooMany', { max: MAX_BUNDLES, count: bundles.items.length }))
  }
  if (loading) return { state: 'loading' }
  if (sources.length === 0 && firstError !== undefined) {
    const failure = classifyFailure(firstError)
    return { state: 'failed', error: { code: failure.code, message: failure.message } }
  }
  const value = filesOf({ plan, clientName: null, sources })
  const observedAt = new Date(
    Math.max(0, ...reads.map((read) => read.dataUpdatedAt), ...stored.map((r) => r.dataUpdatedAt)),
  ).toISOString()
  return missing.length > 0
    ? { state: 'partial', value, source: 'cached', observedAt, missing }
    : { state: 'ready', value, source: 'cached', observedAt }
}

/**
 * "What the plan runs" from the bundle store: the read's state above the
 * raw-text block (loading, failed, partial with what is missing), the block
 * with the files that were read. A failed read keeps the block saying the
 * files are not known, never an empty list.
 */
export function StoredFilesBlock({
  readable,
  collapsedLines,
  onRetry,
}: {
  readonly readable: Readable<PlanFiles>
  readonly collapsedLines: number
  readonly onRetry: () => void
}): ReactNode {
  const value = readableValue(readable)
  return (
    <div className="flex min-w-0 flex-col gap-2" data-stored-files={readable.state}>
      {readable.state === 'loading' ? (
        <LoadingState what={t('plans.files.what').toLowerCase()} lines={4} />
      ) : null}
      {readable.state === 'failed' ? (
        <FailedReadState
          what={t('plans.files.what').toLowerCase()}
          error={readable.error}
          onRetry={onRetry}
          headingLevel={3}
        />
      ) : null}
      {readable.state === 'partial' ? (
        <PartialBanner
          what={t('plans.files.what').toLowerCase()}
          source={readable.source}
          observedAt={readable.observedAt}
          missing={readable.missing}
        />
      ) : null}
      <RawPlanTextBlock
        headingLevel={2}
        files={value?.files ?? null}
        omitted={value?.omitted ?? null}
        runs={value?.runs ?? null}
        collapsedLines={collapsedLines}
      />
      <p className="m-0 text-xs text-foreground-light">{t('plans.files.fromStore')}</p>
    </div>
  )
}
