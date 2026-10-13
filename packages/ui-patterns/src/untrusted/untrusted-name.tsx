import { Button, cn } from '@exponetdb/ui'
import { type HTMLAttributes, type ReactNode, useMemo, useState } from 'react'

import { formatCount } from '../states/format.ts'
import { renderLine } from './render-segments.tsx'
import { codePointCount, EXPANDED_CODE_POINT_LIMIT, takeCodePoints } from './truncate.ts'

/** The default length of a name shown before "Show all", in code points. */
export const DEFAULT_MAX_NAME_CODE_POINTS = 80

export interface UntrustedNameProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** The foreign name: an object name, a client name, a node's host name, a version string. */
  name: string
  /** Adds the marker "name not verified": the name was declared by its owner and nothing checked it. */
  unverified?: boolean
  mono?: boolean
  /** Longest name shown before "Show all", in code points. Default 80. */
  maxCodePoints?: number
  /** Names the value for the "Show all" button of a screen reader ("client name"). */
  label?: string
}

/**
 * A single-line name from untrusted content, inline. Same rules as
 * `UntrustedText` (text nodes only; hidden and direction characters by code
 * point; look-alikes marked; long values cut with an explicit "Show all"), and
 * a line break inside the name is itself shown as `⟨U+000A⟩`, so a name can
 * never take a second line or hide one. `unverified` adds the marker "name not
 * verified", for names a client or a person chose for itself.
 */
export function UntrustedName({
  name,
  unverified = false,
  mono = false,
  maxCodePoints = DEFAULT_MAX_NAME_CODE_POINTS,
  label,
  className,
  ...rest
}: UntrustedNameProps): ReactNode {
  const [expandedName, setExpandedName] = useState<string | null>(null)
  const expanded = expandedName === name

  const collapsed = useMemo(() => takeCodePoints(name, maxCodePoints), [name, maxCodePoints])
  const shown = expanded ? takeCodePoints(name, EXPANDED_CODE_POINT_LIMIT) : collapsed
  const total = useMemo(() => codePointCount(name), [name])
  const rendered = useMemo(() => renderLine(shown.head, 'name'), [shown.head])

  const count = formatCount(total)
  const showAll = `Show all (${count} characters)`

  return (
    <span
      data-untrusted="name"
      className={cn('inline-flex max-w-full flex-wrap items-baseline gap-x-1.5', className)}
      {...rest}
    >
      <span
        dir="ltr"
        className={cn(
          'min-w-0 whitespace-pre-wrap break-words [unicode-bidi:isolate-override]',
          mono && 'font-mono',
        )}
      >
        {name === '' ? (
          <span className="italic text-foreground-muted">(empty)</span>
        ) : (
          rendered.nodes
        )}
        {shown.truncated && <span aria-hidden="true">…</span>}
      </span>
      {expanded && shown.truncated && (
        <span className="text-xs text-foreground-lighter">
          {`Showing the first ${formatCount(EXPANDED_CODE_POINT_LIMIT)} of ${count} characters.`}
        </span>
      )}
      {collapsed.truncated && (
        <Button
          type="button"
          variant="link"
          size="tiny"
          className="h-auto px-0 py-0"
          aria-label={
            expanded ? undefined : label === undefined ? undefined : `${showAll} of ${label}`
          }
          onClick={() => setExpandedName(expanded ? null : name)}
        >
          {expanded ? 'Show less' : showAll}
        </Button>
      )}
      {unverified && (
        <span className="rounded-sm border border-default px-1 text-[11px] leading-4 text-foreground-lighter">
          name not verified
        </span>
      )}
    </span>
  )
}
