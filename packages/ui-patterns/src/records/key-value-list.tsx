import { Button, cn, copyToClipboard, toast } from '@exponetdb/ui'
import type { ReactNode } from 'react'

export interface KeyValueItem {
  /** A stable id of the row, used as its key. */
  id: string
  /** The label, a few words: "Plan hash". */
  label: string
  /** The value. A string, or any node (a chip, a link, an `UntrustedName`). */
  value: ReactNode
  /** Adds a copy button to the row that copies this text. */
  copyText?: string
}

export interface KeyValueListProps {
  items: readonly KeyValueItem[]
  /** Labels beside the values (default) or above them. */
  layout?: 'inline' | 'stacked'
  className?: string
}

async function copyRow(label: string, text: string): Promise<void> {
  if (await copyToClipboard(text)) {
    toast.success(`${label} copied`)
  } else {
    toast.error('Could not copy to the clipboard', { description: `${label} was not copied.` })
  }
}

/**
 * A description list of labels and values, for the facts of one thing (a plan,
 * a node, a target). The values may be any node; a row can offer a copy
 * button. A value that comes from untrusted content must be passed through
 * `UntrustedText` or `UntrustedName` by the caller.
 */
export function KeyValueList({
  items,
  layout = 'inline',
  className,
}: KeyValueListProps): ReactNode {
  return (
    <dl className={cn('flex flex-col gap-2 text-sm', className)}>
      {items.map((item) => (
        <div
          key={item.id}
          className={cn('flex flex-col gap-0.5', layout === 'inline' && 'sm:flex-row sm:gap-4')}
        >
          <dt
            className={cn('text-foreground-lighter', layout === 'inline' && 'sm:w-44 sm:shrink-0')}
          >
            {item.label}
          </dt>
          <dd className="m-0 flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-foreground">
            <span className="min-w-0 break-words">{item.value}</span>
            {item.copyText !== undefined && (
              <Button
                type="button"
                variant="text"
                size="tiny"
                aria-label={`Copy ${item.label}`}
                onClick={() => {
                  void copyRow(item.label, item.copyText ?? '')
                }}
              >
                Copy
              </Button>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
