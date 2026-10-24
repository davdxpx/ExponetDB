import { Button, Label } from '@exponetdb/ui'
import type { Readable } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { NativeSelect } from './fields.tsx'
import { ACCESS_PAGE_LIMIT } from './keys.ts'
import { CHOICE_OLD_AFTER_MS } from './scope-reads.ts'

/**
 * A choice by name over a list the server returns (a product, a project, an
 * environment, a target). It is a convenience in front of a typed ID, never
 * the only way in: the read can fail, be refused or list only the first part,
 * and then the form says so in words and the ID can still be typed. The list
 * is read truthfully (C-28): loading is not empty, a failed or refused read
 * is never an empty list, a list that is cut or old says so, and empty is
 * said only after a successful read.
 *
 * The option text is plain text; callers pass names through `inlineName`, so
 * a hidden or direction character in a name is shown by its code point. The
 * value is the ID.
 */
export interface Choice {
  readonly value: string
  readonly label: string
}

interface Paged {
  readonly nextCursor: string | null
}

/** The part of a query result a choice reads. */
export interface ChoiceQuery<T> {
  readonly data: T | undefined
  readonly error: unknown
  readonly isError: boolean
  readonly dataUpdatedAt: number
  readonly isFetching: boolean
  readonly refetch: () => unknown
}

/** The list read as a truthful state: cut when the server has more, old after a few minutes. */
export function choiceReadable<T extends Paged>(query: ChoiceQuery<T>): Readable<T> {
  return toReadable(query, {
    staleAfterMs: CHOICE_OLD_AFTER_MS,
    missing: (page) =>
      page.nextCursor === null ? undefined : [t('choice.partial', { count: ACCESS_PAGE_LIMIT })],
  })
}

/**
 * The sentence under a choice that says what the read could not give: that
 * it is loading, failed or was refused (never an empty list), is only the
 * first part, is an earlier read, or found nothing. Nothing when the read is
 * complete and holds entries.
 */
export function ChoiceNote({
  id,
  readable,
  error,
  what,
  permission,
  empty,
  onRetry,
}: {
  readonly id: string
  readonly readable: Readable<unknown>
  readonly error: unknown
  readonly what: string
  readonly permission: string
  /** The read succeeded and the list holds no entry. */
  readonly empty: boolean
  readonly onRetry: () => void
}): ReactNode {
  const retry = (text: string): ReactNode => (
    <Button type="button" variant="text" size="tiny" onClick={onRetry}>
      {text}
    </Button>
  )
  switch (readable.state) {
    case 'loading':
      return (
        <p id={id} role="status" className="text-xs text-foreground-lighter">
          {t('choice.loading', { what })}
        </p>
      )
    case 'failed':
      return (
        <p id={id} role="alert" className="text-xs text-foreground-light">
          {classifyFailure(error).kind === 'not_permitted' ? (
            t('choice.notPermitted', { what, permission })
          ) : (
            <>
              {t('choice.failed', { what, reason: describeError(error) })}{' '}
              {retry(t('choice.retry'))}
            </>
          )}
        </p>
      )
    case 'stale':
      return (
        <p id={id} role="status" className="text-xs text-foreground-light">
          {t('choice.stale', { what })} {retry(t('choice.refresh'))}
        </p>
      )
    case 'partial':
      return (
        <p id={id} role="status" className="text-xs text-foreground-light">
          {t('choice.partial', { count: ACCESS_PAGE_LIMIT })}
        </p>
      )
    case 'ready':
      return empty ? (
        <p id={id} role="status" className="text-xs text-foreground-light">
          {t('choice.empty', { what })}
        </p>
      ) : null
  }
}

export interface ChoiceSelectProps<T extends Paged> {
  readonly id: string
  readonly label: string
  /** What is read, after "Could not read": "Target list". */
  readonly what: string
  /** The permission that reading needs, named when the server refuses the read. */
  readonly permission: string
  readonly query: ChoiceQuery<T>
  readonly choices: (page: T) => readonly Choice[]
  /** The text of the option that stands for no choice. */
  readonly placeholder: string
  /** The ID chosen or typed; an ID that is not listed shows the placeholder. */
  readonly value: string
  readonly onChange: (value: string) => void
}

export function ChoiceSelect<T extends Paged>({
  id,
  label,
  what,
  permission,
  query,
  choices,
  placeholder,
  value,
  onChange,
}: ChoiceSelectProps<T>): ReactNode {
  const readable = choiceReadable(query)
  const noteId = `${id}-note`
  const options =
    readable.state === 'loading' || readable.state === 'failed' ? [] : choices(readable.value)
  const known = options.some((option) => option.value === value)
  const empty = readable.state === 'ready' && options.length === 0
  const unavailable = readable.state === 'loading' || readable.state === 'failed'
  const noted = readable.state !== 'ready' || empty
  const note = (
    <ChoiceNote
      id={noteId}
      readable={readable}
      error={query.error}
      what={what}
      permission={permission}
      empty={empty}
      onRetry={() => void query.refetch()}
    />
  )
  return (
    <div className="flex flex-col gap-1.5" data-choice={readable.state}>
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        disabled={unavailable}
        aria-busy={readable.state === 'loading' ? 'true' : undefined}
        aria-describedby={noted ? noteId : undefined}
        value={known ? value : ''}
        options={[
          {
            value: '',
            label: readable.state === 'loading' ? t('choice.loading', { what }) : placeholder,
          },
          ...options,
        ]}
        onChange={(event) => onChange(event.target.value)}
      />
      {note}
    </div>
  )
}
