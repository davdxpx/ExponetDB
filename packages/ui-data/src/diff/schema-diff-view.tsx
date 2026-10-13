import {
  ClassificationBadge,
  type HeadingLevel,
  type NowInput,
  type Readable,
  ReadableView,
  StateHeading,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useMemo } from 'react'

import { ChangeMarker } from './change-marker.tsx'
import { ReadEmpty } from './read-empty.tsx'
import {
  countSchemaChanges,
  countSchemaClasses,
  groupSchemaDiff,
  type SchemaDiffEntry,
  type SchemaDiffGroup,
  type SchemaDiffItem,
} from './schema-diff.ts'

export interface SchemaDiffViewProps {
  /** The entries of the diff, as a read: a failed read is never drawn as "no differences". */
  diff: Readable<readonly SchemaDiffEntry[]>
  /** What is shown, as a noun phrase that works after "no". Default "schema changes". */
  what?: string
  onRetry?: () => void
  onRefresh?: () => void
  busy?: boolean
  now?: NowInput
  /** The level of the headings of the groups. Default 3. */
  headingLevel?: HeadingLevel
  className?: string
}

function count(value: number): string {
  return value.toLocaleString('en-US')
}

function SchemaDiffSummary({ entries }: { entries: readonly SchemaDiffEntry[] }): ReactNode {
  const changes = countSchemaChanges(entries)
  const classes = countSchemaClasses(entries)
  const total = `${count(entries.length)} ${entries.length === 1 ? 'object' : 'objects'}`
  const parts = [
    ...(changes.added > 0 ? [`${count(changes.added)} added`] : []),
    ...(changes.removed > 0 ? [`${count(changes.removed)} removed`] : []),
    ...(changes.changed > 0 ? [`${count(changes.changed)} changed`] : []),
    ...(changes.other > 0 ? [`${count(changes.other)} with an unknown change`] : []),
  ]
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-sm text-foreground-light">
        {parts.length === 0 ? `${total}.` : `${total}: ${parts.join(', ')}.`}
      </p>
      {classes.length > 0 && (
        <ul
          aria-label="Statement classes in this diff"
          className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-sm text-foreground-light"
        >
          {classes.map(([cls, total]) => (
            <li key={cls} className="inline-flex items-center gap-1.5">
              <ClassificationBadge classification={cls} />
              <span>{count(total)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SchemaDiffEntryRow({ item }: { item: SchemaDiffItem }): ReactNode {
  const { entry, classes } = item
  return (
    <li
      data-change={entry.change}
      className="flex flex-col gap-1.5 rounded-md border border-default bg-surface-100 p-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ChangeMarker change={entry.change} />
        <span className="inline-flex min-w-0 flex-wrap items-baseline text-sm text-foreground">
          {entry.schema !== '' && (
            <>
              <UntrustedName name={entry.schema} mono label="schema" />
              <span aria-hidden="true">.</span>
            </>
          )}
          <UntrustedName name={entry.name} mono label="object name" />
        </span>
        {classes.length > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1">
            {classes.map((cls) => (
              <ClassificationBadge key={cls} classification={cls} />
            ))}
          </span>
        )}
      </div>
      {entry.details !== '' && (
        <UntrustedText
          text={entry.details}
          mono
          maxLines={8}
          maxCodePoints={600}
          label="change details"
        />
      )}
    </li>
  )
}

function SchemaDiffGroupSection({
  group,
  headingLevel,
}: {
  group: SchemaDiffGroup
  headingLevel: HeadingLevel
}): ReactNode {
  const headingId = useId()
  const total = group.items.length
  return (
    <section
      aria-labelledby={headingId}
      data-object-type={group.objectType}
      className="flex flex-col gap-2"
    >
      <StateHeading
        id={headingId}
        level={headingLevel}
        className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground"
      >
        {group.label === null ? (
          <UntrustedName name={group.objectType} label="object type" />
        ) : (
          <span>{group.label}</span>
        )}
        <span className="font-normal text-foreground-lighter">{`(${count(total)})`}</span>
      </StateHeading>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {group.items.map((item) => (
          <SchemaDiffEntryRow key={item.key} item={item} />
        ))}
      </ul>
    </section>
  )
}

function SchemaDiffBody({
  entries,
  headingLevel,
}: {
  entries: readonly SchemaDiffEntry[]
  headingLevel: HeadingLevel
}): ReactNode {
  const groups = useMemo(() => groupSchemaDiff(entries), [entries])
  return (
    <div className="flex flex-col gap-4">
      <SchemaDiffSummary entries={entries} />
      {groups.map((group) => (
        <SchemaDiffGroupSection key={group.objectType} group={group} headingLevel={headingLevel} />
      ))}
    </div>
  )
}

/**
 * A schema diff by object (design-system.md §3): grouped by object type, each
 * object with an icon and a word for added, removed or changed and a
 * classification badge for every statement class that applies (destructive,
 * rewrite, non-transactional, security). Schema, name and details are
 * untrusted text. The entries are a `Readable`: a failed read is a failed
 * read, a partial one says what is missing, and neither is drawn as "no
 * differences".
 */
export function SchemaDiffView({
  diff,
  what = 'schema changes',
  onRetry,
  onRefresh,
  busy,
  now,
  headingLevel = 3,
  className,
}: SchemaDiffViewProps): ReactNode {
  return (
    <div className={className}>
      <ReadableView
        readable={diff}
        what={what}
        onRetry={onRetry}
        onRefresh={onRefresh}
        busy={busy}
        now={now}
        headingLevel={headingLevel}
        ready={(value, meta) =>
          value.length === 0 ? (
            <ReadEmpty title="No differences" noun={what} meta={meta} headingLevel={headingLevel} />
          ) : (
            <SchemaDiffBody entries={value} headingLevel={headingLevel} />
          )
        }
      />
    </div>
  )
}
