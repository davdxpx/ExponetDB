import type { MigrationStream } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { StateHeading, TierChip, UntrustedName, useLinkComponent } from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { targetHref } from '../../shell/navigation.ts'
import { isSlug, isTargetPath, splitTargetPath } from '../target/params.ts'
import {
  candidatesFor,
  defaultDestination,
  type PromotionCandidate,
  plannableEnvironments,
} from './bundle-model.ts'
import { BundleCheckbox, SelectAllCheckbox, useBundleSelection } from './bundle-select.tsx'
import { ViewSqlButton } from './bundle-sheet.tsx'
import { EvidenceNote, PlanBundlesAction } from './plan-bundles.tsx'

type StreamEnvironment = MigrationStream['environments'][number]

/** An environment the panel may plan on: a valid slug and a target with a valid path. */
interface Destination {
  readonly slug: string
  readonly tier: string
  readonly evidenceFrom: string | null
  readonly targetPath: string
}

function destinationsOf(stream: MigrationStream): readonly Destination[] {
  const out: Destination[] = []
  for (const environment of plannableEnvironments(stream)) {
    const path = environment.target?.path
    if (!isSlug(environment.slug) || path === undefined || !isTargetPath(path)) continue
    out.push({
      slug: environment.slug,
      tier: environment.tier,
      evidenceFrom: environment.evidenceFrom,
      targetPath: path,
    })
  }
  return out
}

/** The compare page of `destination` against its evidence environment, when both have a target. */
export function compareHref(
  stream: MigrationStream,
  destination: Pick<Destination, 'targetPath' | 'evidenceFrom'>,
): string | undefined {
  const from = destination.evidenceFrom
  if (from === null || !isSlug(from)) return undefined
  const source: StreamEnvironment | undefined = stream.environments.find((e) => e.slug === from)
  if (source?.target === null || source === undefined) return undefined
  const route = splitTargetPath(destination.targetPath)
  if (route === undefined) return undefined
  return `${targetHref(route, '/compare')}?to=${from}`
}

const STATE_KEYS = {
  not_applied: 'promote.state.not_applied',
  unknown: 'promote.state.unknown',
} as const

/**
 * Promotion of stored bundles (`/changes/promotion` and the migrations
 * page): pick an environment of the project, see the bundles of the stream
 * the Control Store mirror holds as not applied there (or holds nothing
 * for), with the evidence environment's state for a production-tier one,
 * open each bundle's SQL, and plan the chosen ones on that environment's
 * target ("Plan on <environment>"). The list is the mirror's (`source:
 * cached`); the server reads the target and the evidence live when it
 * plans, and decides.
 */
export function PromotePanel({
  stream,
  current,
  headingLevel = 3,
  heading = true,
}: {
  readonly stream: MigrationStream
  /** The environment of the target page the panel is on, if any. */
  readonly current?: string
  readonly headingLevel?: 2 | 3
  /** Whether the panel shows its own title and description (not inside a titled section). */
  readonly heading?: boolean
}): ReactNode {
  const ids = useId()
  const Link = useLinkComponent()
  const destinations = destinationsOf(stream)
  const [chosen, setChosen] = useState<string | undefined>(() =>
    defaultDestination(stream, current),
  )
  const destination = destinations.find((d) => d.slug === chosen) ?? destinations[0]
  const candidates = destination === undefined ? [] : candidatesFor(stream, destination.slug)
  const selection = useBundleSelection(
    `${stream.projectId}:${destination?.slug ?? ''}`,
    candidates.map((c) => c.migrationId),
  )
  const production = destination !== undefined && destination.tier !== 'nonprod'
  const compare = destination === undefined ? undefined : compareHref(stream, destination)

  return (
    <section
      aria-labelledby={heading ? `${ids}-title` : undefined}
      aria-label={heading ? undefined : t('promote.title')}
      className="flex min-w-0 flex-col gap-3"
      data-promote={stream.projectId}
    >
      {heading ? (
        <>
          <StateHeading
            id={`${ids}-title`}
            level={headingLevel}
            className="m-0 text-base font-medium"
          >
            {t('promote.title')}
          </StateHeading>
          <p className="m-0 text-sm text-foreground-light">{t('promote.description')}</p>
        </>
      ) : null}
      {destinations.length === 0 ? (
        <p className="m-0 text-sm text-foreground-light">{t('promote.noEnvironment')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor={`${ids}-env`} className="flex flex-col gap-1 text-xs">
              <span className="text-foreground-light">{t('promote.environment')}</span>
              <select
                id={`${ids}-env`}
                className="h-[30px] rounded-md border border-control bg-control px-2 text-sm"
                value={destination?.slug ?? ''}
                onChange={(event) => setChosen(event.target.value)}
              >
                {destinations.map((d) => (
                  <option key={d.slug} value={d.slug}>
                    {d.tier === 'nonprod'
                      ? d.slug
                      : t('promote.environment.production', { environment: d.slug })}
                  </option>
                ))}
              </select>
            </label>
            {production && destination !== undefined ? (
              <TierChip tier="prod" name={destination.slug} />
            ) : null}
            {compare === undefined || destination === undefined ? null : (
              <Link href={compare} className="text-sm text-primary underline focus-ring">
                {t('promote.compare', {
                  environment: destination.slug,
                  from: destination.evidenceFrom ?? '',
                })}
              </Link>
            )}
          </div>
          {stream.truncated ? (
            <p role="note" className="m-0 text-sm text-foreground-light">
              {t('promote.truncated', { shown: stream.bundles.length, total: stream.bundleCount })}
            </p>
          ) : null}
          {destination === undefined ? null : candidates.length === 0 ? (
            <p className="m-0 text-sm text-foreground-light" data-empty="promote">
              {t('promote.none', { environment: destination.slug })}
            </p>
          ) : (
            <CandidateTable
              projectId={stream.projectId}
              destination={destination}
              candidates={candidates}
              production={production}
              isSelected={selection.isSelected}
              onToggle={selection.toggle}
              onAll={selection.setAll}
              selectedCount={selection.selected.length}
            />
          )}
          {destination === undefined ? null : (
            <PlanBundlesAction
              targetPath={destination.targetPath}
              environment={destination.slug}
              tier={destination.tier}
              bundles={candidates.filter((c) => selection.isSelected(c.migrationId))}
            />
          )}
        </>
      )}
    </section>
  )
}

function CandidateTable({
  projectId,
  destination,
  candidates,
  production,
  isSelected,
  onToggle,
  onAll,
  selectedCount,
}: {
  readonly projectId: string
  readonly destination: Destination
  readonly candidates: readonly PromotionCandidate[]
  readonly production: boolean
  readonly isSelected: (id: string) => boolean
  readonly onToggle: (id: string, on: boolean) => void
  readonly onAll: (on: boolean) => void
  readonly selectedCount: number
}): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">
        {t('promote.caption', { environment: destination.slug })}
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="w-0">
            <SelectAllCheckbox
              total={candidates.length}
              selected={selectedCount}
              onChange={onAll}
            />
          </TableHead>
          <TableHead scope="col">{t('promote.column.bundle')}</TableHead>
          <TableHead scope="col">
            {t('promote.column.state', { environment: destination.slug })}
          </TableHead>
          {production ? <TableHead scope="col">{t('promote.column.evidence')}</TableHead> : null}
          <TableHead scope="col">
            <span className="sr-only">{t('promote.column.sql')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {candidates.map((candidate) => (
          <TableRow key={candidate.migrationId} data-candidate={candidate.migrationId}>
            <TableCell>
              <BundleCheckbox
                migrationId={candidate.migrationId}
                checked={isSelected(candidate.migrationId)}
                onChange={(on) => onToggle(candidate.migrationId, on)}
              />
            </TableCell>
            <TableCell>
              <UntrustedName name={candidate.name} label={t('promote.column.bundle')} />
              <div className="font-mono text-xs text-foreground-lighter">
                {candidate.migrationId}
              </div>
            </TableCell>
            <TableCell>{t(STATE_KEYS[candidate.state])}</TableCell>
            {production ? (
              <TableCell className="text-sm">
                <EvidenceNote evidence={candidate.evidence} destination={destination.slug} />
              </TableCell>
            ) : null}
            <TableCell>
              <ViewSqlButton
                bundle={{
                  projectId,
                  migrationId: candidate.migrationId,
                  name: candidate.name,
                  targetPath: destination.targetPath,
                  revision: candidate.revision,
                }}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
