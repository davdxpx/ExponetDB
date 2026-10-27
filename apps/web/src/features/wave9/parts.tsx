import type { Operation } from '@exponetdb/sdk/operations'
import { Badge, Button, Label } from '@exponetdb/ui'
import { useLinkComponent } from '@exponetdb/ui-patterns'
import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query'
import { type ReactNode, useCallback, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds, NativeSelect, type Permission } from '../access/fields.tsx'
import { actionError } from '../plans/failure.ts'
import { operationPath } from '../target-ops/ids.ts'
import type { SectionQuery } from '../target-ops/read-section.tsx'
import {
  badgeVariant,
  LOCK_KEYS,
  lockProtects,
  PROTECTION_KEYS,
  type ProtectionState,
  protectionStateOf,
  protectionTone,
  type Tone,
} from './model.ts'

/** A word in a badge; the word is the signal, the color only helps (never green for unknown). */
export function ToneBadge({
  tone,
  children,
  ...data
}: {
  readonly tone: Tone
  readonly children: ReactNode
} & Readonly<Record<`data-${string}`, string>>): ReactNode {
  return (
    <Badge variant={badgeVariant(tone)} data-tone={tone} {...data}>
      {children}
    </Badge>
  )
}

/** A cluster's protection state as a word; only `protected` is drawn as good. */
export function ProtectionBadge({ state }: { readonly state: unknown }): ReactNode {
  const known: ProtectionState = protectionStateOf(state)
  return (
    <ToneBadge tone={protectionTone(known)} data-protection={known}>
      {t(PROTECTION_KEYS[known])}
    </ToneBadge>
  )
}

/** A repository's lock: protecting only when proven, every other value says "not proven". */
export function LockBadge({ capability }: { readonly capability: string }): ReactNode {
  const proven = lockProtects(capability)
  const key = Object.hasOwn(LOCK_KEYS, capability)
    ? LOCK_KEYS[capability as keyof typeof LOCK_KEYS]
    : LOCK_KEYS.unknown
  return (
    <ToneBadge tone={proven ? 'good' : 'neutral'} data-lock={capability}>
      {t(key)}
    </ToneBadge>
  )
}

/** A list of facts as a description list (term above value). */
export function Facts({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </dl>
  )
}

export function Fact({
  label,
  children,
  ...data
}: {
  readonly label: string
  readonly children: ReactNode
} & Readonly<Record<`data-${string}`, string>>): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1" {...data}>
      <dt className="eyebrow text-xs text-foreground-lighter">{label}</dt>
      <dd className="m-0 text-sm">{children}</dd>
    </div>
  )
}

/** "None recorded" in the muted style of a missing value (never a zero, never a blank). */
export function Missing({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className="text-foreground-light">{children}</span>
}

function freshnessOf(page: unknown): { source?: unknown; observedAt?: unknown } {
  if (typeof page !== 'object' || page === null) return {}
  const record = page as Readonly<Record<string, unknown>>
  return {
    ...(record['source'] === undefined ? {} : { source: record['source'] }),
    ...(typeof record['observedAt'] === 'string' ? { observedAt: record['observedAt'] } : {}),
  }
}

/** A page of a list as the backup routes send it: the items under their own key and a cursor. */
export interface PagedItems<I, F> {
  readonly items: readonly I[]
  readonly more: boolean
  /** The first page as it came (the facts beside the list: protection, coverage, source). */
  readonly first: F
  /** The first page's source and time, when it has them (what decides a stale read). */
  readonly source?: unknown
  readonly observedAt?: unknown
}

/**
 * The pages of an infinite read as one list for `ReadSection`, with whether
 * the server has more. A later page that fails keeps the earlier items and
 * makes the read stale (the section shows the failure), never an empty list.
 */
export function flatPages<P extends { readonly nextCursor: string | null }, I>(
  query: UseInfiniteQueryResult<InfiniteData<P, unknown>, unknown>,
  itemsOf: (page: P) => readonly I[],
): SectionQuery<PagedItems<I, P>> {
  const pages = query.data?.pages
  const first = pages?.[0]
  return {
    data:
      pages === undefined || first === undefined
        ? undefined
        : {
            items: pages.flatMap(itemsOf),
            more: query.hasNextPage,
            first,
            // The first page's own source and time decide stale (C-28), not when the page got it.
            ...freshnessOf(first),
          },
    error: query.error,
    isError: query.isError,
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: () => query.refetch(),
  }
}

/** Whether the session holds a permission (what the page offers; the server decides every request). */
export function useHolds(): (permission: Permission) => boolean {
  const me = useMe()
  return (permission) => holds(me, permission)
}

/**
 * Actions the server refused as not activated on this installation
 * (`FEATURE_NOT_ACTIVATED`): from then on the page shows them disabled with
 * the server's reason, so nobody presses them again to learn the same.
 */
export interface Refusals {
  readonly reasonOf: (action: string) => string | undefined
  /** Records a refusal when the error is one; returns whether it was. */
  readonly record: (action: string, error: unknown) => boolean
}

export function useRefusals(): Refusals {
  const [refused, setRefused] = useState<Readonly<Record<string, string>>>({})
  const record = useCallback((action: string, error: unknown): boolean => {
    if (!(error instanceof ApiError) || error.code !== 'FEATURE_NOT_ACTIVATED') return false
    const reason = t('error.withCode', { message: error.message, code: error.code })
    setRefused((current) => ({ ...current, [action]: reason }))
    return true
  }, [])
  const reasonOf = useCallback((action: string) => refused[action], [refused])
  return { reasonOf, record }
}

/**
 * A button of an action the page offers, or the same button disabled with
 * the reason beside it (a missing permission, a refusal of the server, a
 * fact of the record). The reason is visible text and the button's
 * description, so a person and a screen reader learn why.
 */
export function ActionButton({
  label,
  disabledReason,
  onClick,
  destructive = false,
  ...data
}: {
  readonly label: string
  readonly disabledReason: string | undefined
  readonly onClick: () => void
  readonly destructive?: boolean
} & Readonly<Record<`data-${string}`, string>>): ReactNode {
  const id = useId()
  const disabled = disabledReason !== undefined
  return (
    <div className="flex min-w-0 flex-col items-start gap-1" {...data}>
      <Button
        type="button"
        size="tiny"
        variant={destructive ? 'danger' : 'default'}
        disabled={disabled}
        aria-describedby={disabled ? `${id}-reason` : undefined}
        onClick={onClick}
      >
        {label}
      </Button>
      {disabled ? (
        <p id={`${id}-reason`} className="m-0 text-xs text-foreground-light" data-reason="">
          {disabledReason}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Starts an inline operation (a verify, a catalog refresh, a query cancel):
 * with re-authentication when the server asks for it, a failure turned into
 * catalog text for the dialog that shows it. The answer is an operation that
 * started, not one that succeeded (C-12): the caller links it.
 */
export function useInlineOperation(): (start: () => Promise<Operation>) => Promise<Operation> {
  const { client, confirmIdentity } = useApi()
  return useCallback(
    async (start) => {
      try {
        return await withReauth(client, confirmIdentity, start)
      } catch (error) {
        throw actionError(error)
      }
    },
    [client, confirmIdentity],
  )
}

/** "Started. Follow operation op_… for its outcome." with the operation's page linked. */
export function StartedNotice({
  operation,
  message,
}: {
  readonly operation: Operation | undefined
  readonly message: string
}): ReactNode {
  const Link = useLinkComponent()
  if (operation === undefined) return null
  const href = operationPath(operation.id)
  return (
    <p className="m-0 text-sm" role="status" data-started={operation.id}>
      {message}{' '}
      {href === undefined ? null : (
        <Link href={href} className="text-primary underline focus-ring">
          {t('wave9.action.followOperation')}
        </Link>
      )}
    </p>
  )
}

/** A labeled native select of fixed values (the platform's keyboard and screen reader behavior). */
export function SelectField<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  readonly label: string
  readonly value: V
  readonly options: readonly { readonly value: V; readonly label: string }[]
  readonly onChange: (value: V) => void
  readonly disabled?: boolean
}): ReactNode {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={value}
        options={options}
        disabled={disabled}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value)
          if (next !== undefined) onChange(next.value)
        }}
      />
    </div>
  )
}
