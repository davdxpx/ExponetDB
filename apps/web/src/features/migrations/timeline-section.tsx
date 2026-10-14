import type { MigrationStream } from '@exponetdb/sdk/operations'
import { MigrationTimeline } from '@exponetdb/ui-data'
import { NotPermittedState, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { nounPhrase } from '../target/phrases.ts'
import { streamQuery } from '../target-ops/keys.ts'
import { Section } from '../target-ops/section.tsx'
import {
  type EnvironmentNote,
  environmentNotes,
  mapReadable,
  streamMissing,
  timelineDataOf,
} from './model.ts'

/**
 * The promotion timeline of the project (`GET /projects/{id}/migrations`):
 * bundles in dependency order, one column per environment in evidence order,
 * a marker per cell. The data are the Control Store mirrors (`source:
 * cached`), written by the worker after each operation, not a live read of
 * the targets; a cell the mirror holds nothing for is `unknown`, never "not
 * applied". The notes under it name the environments whose cells say less
 * than they seem to.
 */
export function TimelineSection({ projectId }: { readonly projectId: string }): ReactNode {
  const { client } = useApi()
  const query = useQuery(streamQuery(client, projectId))
  const refetch = () => void query.refetch()
  const refused =
    query.data === undefined &&
    query.isError &&
    classifyFailure(query.error).kind === 'not_permitted'
  const stream = toReadable(query, { missing: streamMissing })
  return (
    <Section
      id="timeline"
      title={t('migrations.timeline.title')}
      description={t('migrations.timeline.description')}
    >
      {refused ? (
        <NotPermittedState
          what={nounPhrase('migrations.timeline.what')}
          permission="migrations.read"
          headingLevel={3}
        />
      ) : (
        <>
          <MigrationTimeline
            readable={mapReadable(stream, timelineDataOf)}
            what={nounPhrase('migrations.timeline.what')}
            onRetry={refetch}
            onRefresh={refetch}
            busy={query.isFetching}
            headingLevel={3}
          />
          {query.data === undefined ? null : <EnvironmentNotes stream={query.data} />}
        </>
      )}
    </Section>
  )
}

function EnvironmentNotes({ stream }: { readonly stream: MigrationStream }): ReactNode {
  const notes = environmentNotes(stream)
  const invalid = !stream.graph.valid
  if (notes.length === 0 && !invalid) return null
  return (
    <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-foreground-light">
      {invalid ? <li>{t('migrations.timeline.graphInvalid')}</li> : null}
      {notes.map((note) => (
        <li key={`${note.kind}:${note.slug}`}>
          <NoteText note={note} />
        </li>
      ))}
    </ul>
  )
}

function NoteText({ note }: { readonly note: EnvironmentNote }): ReactNode {
  const environment = (
    <UntrustedName name={note.slug} mono label={t('migrations.timeline.environment')} />
  )
  switch (note.kind) {
    case 'no_target':
      return (
        <>
          {environment}: {t('migrations.timeline.noTarget')}
        </>
      )
    case 'no_mirror':
      return (
        <>
          {environment}: {t('migrations.timeline.noMirror')}
        </>
      )
    case 'divergent':
      return (
        <>
          {environment}:{' '}
          {t('migrations.timeline.divergent', {
            missing: note.missing.length,
            differs: note.checksumDiffers.length,
            unrecorded: note.unrecorded.length,
          })}
        </>
      )
  }
}
