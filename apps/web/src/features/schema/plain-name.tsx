import { cn } from '@exponetdb/ui'
import { renderLine, takeCodePoints } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

/**
 * A name from the catalog in one line with no control of its own, for the
 * places a button may not sit inside (an option of a list, a trigger, a
 * chip's label). Same rules as `UntrustedName` without "Show all": text nodes
 * only, hidden and direction characters by code point, look-alikes marked,
 * cut with an ellipsis at `max` code points. Where a name can be long and a
 * person may need all of it, use `UntrustedName` beside it.
 */
export function PlainName(props: {
  readonly text: string
  readonly max?: number
  readonly mono?: boolean
  readonly className?: string
}): ReactNode {
  const cut = takeCodePoints(props.text, props.max ?? 64)
  return (
    <span
      data-untrusted="name"
      dir="ltr"
      className={cn(
        'min-w-0 break-words [unicode-bidi:isolate-override]',
        props.mono === true && 'font-mono',
        props.className,
      )}
    >
      {props.text === '' ? (
        <span className="italic">(empty)</span>
      ) : (
        renderLine(cut.head, 'name').nodes
      )}
      {cut.truncated ? <span aria-hidden="true">…</span> : null}
    </span>
  )
}
