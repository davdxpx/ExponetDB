import { Copy } from '@exponetdb/icons'
import { Button, cn, copyToClipboard } from '@exponetdb/ui'
import {
  formatAge,
  formatUtc,
  type NowInput,
  renderLine,
  toIso,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import { Children, type ReactNode, useRef, useState } from 'react'

import { NOT_KNOWN } from './format.ts'

/**
 * Small building blocks of the plan review blocks. Every string that is shown
 * goes through `renderLine` (C-26: invisible, direction and control
 * characters by code point, look-alikes marked) or an untrusted-text
 * component; nothing is rendered as markup or as a link.
 */

/**
 * React keys for items whose natural id may repeat: the id plus the number of
 * earlier items with the same id, so two equal ids never merge into one row
 * and a key does not depend on the position alone.
 */
export function keyedBy<T>(
  items: readonly T[],
  idOf: (item: T) => string,
): readonly { readonly item: T; readonly key: string }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const id = idOf(item)
    const count = seen.get(id) ?? 0
    seen.set(id, count + 1)
    return { item, key: `${id}#${count}` }
  })
}

/** `keyedBy` for items that carry their id as `key`. */
export function withKeys<T extends { readonly key: string }>(
  items: readonly T[],
): readonly { readonly item: T; readonly key: string }[] {
  return keyedBy(items, (item) => item.key)
}

/** The value of a fixed label table, never a property inherited from `Object.prototype`. */
export function lookup(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/**
 * Inline parts of one phrase, separated by real spaces (not by layout gaps),
 * so the phrase reads, copies and is spoken as words.
 */
export function Words({
  children,
  className,
  ...data
}: {
  readonly children: ReactNode
  readonly className?: string
  readonly [dataAttribute: `data-${string}`]: string | undefined
}): ReactNode {
  const parts = Children.toArray(children)
  return (
    <span {...data} className={className}>
      {parts.flatMap((part, index) => (index === 0 ? [part] : [' ', part]))}
    </span>
  )
}

/** An icon inside a line of text, aligned with the text. */
export const INLINE_ICON = 'inline-block size-3.5 shrink-0 align-[-0.15em]'

/** "not known", in a style that never reads as a value. */
export function NotKnown({ children }: { readonly children?: ReactNode }): ReactNode {
  return (
    <span data-not-known="" className="text-foreground-lighter italic">
      {NOT_KNOWN}
      {children === undefined ? null : <> {children}</>}
    </span>
  )
}

/**
 * A short string in full, marked like untrusted text and isolated from the
 * direction of the text around it. For identifiers, kinds and other server
 * values; long foreign names go through `UntrustedName` instead.
 */
export function Marked({
  text,
  mono = false,
  className,
}: {
  readonly text: string
  readonly mono?: boolean
  readonly className?: string
}): ReactNode {
  return (
    <span
      dir="ltr"
      translate="no"
      className={cn(
        'break-words [unicode-bidi:isolate-override] [&_[data-segment]]:[unicode-bidi:isolate]',
        mono && 'font-mono text-xs',
        className,
      )}
    >
      {renderLine(text, 'marked').nodes}
    </span>
  )
}

/**
 * Text a person must read exactly (a plan hash, a checksum, a fingerprint), in
 * a `code` element, in full: never truncated, never translated, laid out left
 * to right, with every hidden character shown by its code point.
 */
export function FullCode({
  text,
  className,
  ...rest
}: {
  readonly text: string
  readonly className?: string
  readonly 'data-full-hash'?: string
}): ReactNode {
  return (
    <code
      dir="ltr"
      translate="no"
      className={cn(
        'rounded-sm bg-surface-200 px-1 py-0.5 font-mono text-xs break-all whitespace-pre-wrap text-foreground [unicode-bidi:isolate-override] [&_[data-segment]]:[unicode-bidi:isolate]',
        className,
      )}
      {...rest}
    >
      {renderLine(text, 'code').nodes}
    </code>
  )
}

/**
 * A time as `2026-10-13 14:03 UTC (4 min ago)`; "time not known" for a value
 * that is not a date. `null` is "time not known" as well.
 */
export function TimeText({
  at,
  now,
  withAge = true,
}: {
  readonly at: string | null
  readonly now?: NowInput
  readonly withAge?: boolean
}): ReactNode {
  const current = useResolvedNow(now)
  const iso = at === null ? undefined : toIso(at)
  const utc = at === null ? undefined : formatUtc(at)
  if (at === null || iso === undefined || utc === undefined) {
    return <span className="text-foreground-lighter italic">time not known</span>
  }
  const age = withAge ? formatAge(at, current) : undefined
  return <time dateTime={iso}>{age === undefined ? utc : `${utc} (${age})`}</time>
}

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * A copy button for one exact text and its result as a status message. The
 * copied text is exactly `text`; the result never claims success when the
 * clipboard refused.
 */
export function CopyButton({
  text,
  label,
  buttonText = 'Copy',
  copiedMessage,
  className,
}: {
  readonly text: string
  /** What is copied, in words: "plan hash", "up.sql of 01J…". */
  readonly label: string
  readonly buttonText?: string
  /** The status after a successful copy. Default "<Label> copied." */
  readonly copiedMessage?: string
  readonly className?: string
}): ReactNode {
  // The result belongs to one text: a different text starts without a result.
  const [result, setResult] = useState<{ readonly text: string; readonly state: CopyState }>({
    text,
    state: 'idle',
  })
  const pending = useRef(false)
  const state = result.text === text ? result.state : 'idle'
  const sentence = `${label.charAt(0).toUpperCase()}${label.slice(1)}`
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      <Button
        type="button"
        variant="default"
        size="tiny"
        icon={<Copy />}
        aria-label={`Copy ${label}`}
        onClick={async () => {
          if (pending.current) return
          pending.current = true
          try {
            const copied = await copyToClipboard(text)
            setResult({ text, state: copied ? 'copied' : 'failed' })
          } finally {
            pending.current = false
          }
        }}
      >
        {buttonText}
      </Button>
      <span role="status" className="text-xs text-foreground-light">
        {state === 'copied'
          ? (copiedMessage ?? `${sentence} copied.`)
          : state === 'failed'
            ? `Could not copy the ${label}. Select it and copy it instead.`
            : ''}
      </span>
    </span>
  )
}

export interface FactItem {
  /** A stable id of the row. */
  readonly id: string
  /** Plain text. */
  readonly label: string
  readonly value: ReactNode
}

/**
 * A description list of facts. Values are block containers (`div`), so a
 * value may hold a list or a table.
 */
export function Facts({
  items,
  className,
}: {
  readonly items: readonly FactItem[]
  readonly className?: string
}): ReactNode {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.id} data-fact={item.id} className="contents">
          <dt className="text-foreground-lighter">{item.label}</dt>
          <dd className="m-0 min-w-0 break-words text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A note in the flow of a block: role `note`, a warning tone for what a person must not miss. */
export function Note({
  tone = 'default',
  children,
  className,
  id,
  ...data
}: {
  readonly tone?: 'default' | 'warning'
  readonly children: ReactNode
  readonly className?: string
  readonly id?: string
  readonly [dataAttribute: `data-${string}`]: string | undefined
}): ReactNode {
  return (
    <div
      {...data}
      id={id}
      role="note"
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'warning'
          ? 'border-warning-500 bg-warning-200 text-foreground'
          : 'border-default bg-surface-75 text-foreground-light',
        className,
      )}
    >
      {children}
    </div>
  )
}
