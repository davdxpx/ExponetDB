import { cn } from '@exponetdb/ui'
import { renderLine, takeCodePoints } from '@exponetdb/ui-patterns'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import type { ReactNode } from 'react'

import { keysFor } from './keys.ts'
import { NODE_HEADER_HEIGHT, NODE_ROW_HEIGHT } from './layout.ts'
import type { ErdNodeModel } from './model.ts'

export type TableNodeData = {
  readonly entry: ErdNodeModel
  /** DOM id of the table name, so the node is named by it (`aria-labelledby`). */
  readonly nameId: string
  /** Qualified names of the tables this table references, for a screen reader. */
  readonly referenceNames: readonly string[]
  readonly referencedByNames: readonly string[]
}

export type TableFlowNode = Node<TableNodeData, 'table'>

/** Names listed in the spoken summary of a table before "and N more". */
const SPOKEN_NAMES = 6
const NAME_CODE_POINTS = 48
const SPOKEN_NAME_CODE_POINTS = 120
const TYPE_CODE_POINTS = 24

interface ErdNameProps {
  text: string
  max: number
  className?: string
}

/**
 * A name from the schema in one line, cut with an ellipsis (the table view has the full text).
 * Same rules as `UntrustedName`: text nodes only, hidden and direction characters shown by code
 * point, look-alikes marked. No "Show all" button: a table of the diagram has a fixed size.
 */
function ErdName({ text, max, className }: ErdNameProps): ReactNode {
  const { head, truncated } = takeCodePoints(text, max)
  const rendered = renderLine(head, 'name')
  return (
    <span
      dir="ltr"
      className={cn('block min-w-0 truncate [unicode-bidi:isolate-override]', className)}
    >
      {text === '' ? <span className="italic text-foreground-muted">(empty)</span> : rendered.nodes}
      {truncated && <span aria-hidden="true">…</span>}
    </span>
  )
}

function KeyTag({ short, long }: { short: string; long: string }): ReactNode {
  return (
    <span className="shrink-0 rounded-sm border border-default px-1 text-[10px] leading-4 text-foreground-light">
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{long}</span>
    </span>
  )
}

/** The tables named in a spoken summary: the first few, then how many more. */
function SpokenNames({ label, names }: { label: string; names: readonly string[] }): ReactNode {
  if (names.length === 0) return null
  const shown = names.slice(0, SPOKEN_NAMES)
  const keys = keysFor(shown)
  const rest = names.length - shown.length
  return (
    <span>
      {label}{' '}
      {shown.map((name, index) => (
        <span key={keys[index]}>
          {index > 0 && ', '}
          <ErdName text={name} max={NAME_CODE_POINTS} className="inline" />
        </span>
      ))}
      {rest > 0 && ` and ${rest} more`}.{' '}
    </span>
  )
}

const HANDLE_CLASS = 'border-0! bg-transparent!'

/**
 * A table of the diagram: its name (schema and table), then one row per column with its type and
 * primary key and foreign key markers in words as well as letters. The node is a labelled group
 * that takes keyboard focus; a screen reader also gets which tables it references. Fixed size
 * (`layout.ts`): rows beyond the limit are counted in a last row.
 */
export function TableNode({ data }: NodeProps<TableFlowNode>): ReactNode {
  const { entry, nameId, referenceNames, referencedByNames } = data
  const { table } = entry
  const columnKeys = keysFor(entry.shownColumns.map((column) => column.name))
  const spokenName = renderLine(
    takeCodePoints(`${table.schema}.${table.name}`, SPOKEN_NAME_CODE_POINTS).head,
    'spoken',
  )
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
      <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-strong bg-surface-100 text-xs text-foreground shadow-sm">
        <div
          className="flex shrink-0 items-center gap-1 border-b border-default bg-surface-200 px-3"
          style={{ height: NODE_HEADER_HEIGHT }}
        >
          <span id={nameId} className="min-w-0 flex-1 text-sm font-medium">
            <span aria-hidden="true" className="flex items-baseline gap-0.5">
              <ErdName
                text={table.schema}
                max={24}
                className="max-w-[40%] shrink-0 text-foreground-light"
              />
              <span className="text-foreground-lighter">.</span>
              <ErdName text={table.name} max={NAME_CODE_POINTS} className="flex-1" />
            </span>
            {/* The name for a screen reader: one piece of text, in full up to a bound. */}
            <span className="sr-only">{spokenName.nodes}</span>
          </span>
        </div>
        <p className="sr-only">
          {table.columns.length} {table.columns.length === 1 ? 'column' : 'columns'}.{' '}
          <SpokenNames label="References" names={referenceNames} />
          <SpokenNames label="Referenced by" names={referencedByNames} />
        </p>
        <ul aria-label="Columns" className="m-0 flex min-h-0 flex-1 list-none flex-col p-0">
          {entry.shownColumns.length === 0 && (
            <li
              className="flex items-center px-3 italic text-foreground-light"
              style={{ height: NODE_ROW_HEIGHT }}
            >
              No columns
            </li>
          )}
          {entry.shownColumns.map((column, index) => (
            <li
              key={columnKeys[index]}
              className="flex items-center gap-2 border-b border-default/50 px-3 last:border-b-0"
              style={{ height: NODE_ROW_HEIGHT }}
            >
              <ErdName text={column.name} max={NAME_CODE_POINTS} className="flex-1 font-mono" />
              {column.pk === true && <KeyTag short="PK" long="primary key" />}
              {entry.foreignKeyColumns.has(column.name) && <KeyTag short="FK" long="foreign key" />}
              <ErdName
                text={column.type}
                max={TYPE_CODE_POINTS}
                className="max-w-[40%] shrink-0 font-mono text-foreground-lighter"
              />
            </li>
          ))}
          {entry.hiddenColumnCount > 0 && (
            <li
              className="flex items-center px-3 italic text-foreground-light"
              style={{ height: NODE_ROW_HEIGHT }}
            >
              {`and ${entry.hiddenColumnCount} more columns (see the table view)`}
            </li>
          )}
        </ul>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
    </>
  )
}
