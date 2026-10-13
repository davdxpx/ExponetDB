import { Copy } from '@exponetdb/icons'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@exponetdb/ui'
import { codePointCount, formatCount, UntrustedName, UntrustedText } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

import type { CellView } from './cell-format.ts'
import type { ColumnMeta } from './column-kind.ts'
import { CellToken } from './grid-cell.tsx'
import { prettyJson } from './json-text.ts'

/** The sheet shows this much of a value before its own "Show all". */
const SHEET_CODE_POINTS = 20_000
const SHEET_LINES = 1_000

export interface FullValueSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  column: ColumnMeta | undefined
  /** 1-based data row. */
  row: number
  view: CellView | undefined
  /** Copies the value; the caller owns the clipboard and the notice. */
  onCopy: () => void
  /**
   * Called when the sheet has closed: put the focus back where the person was (the cell).
   * The sheet has no trigger element, so the dialog primitive has nothing to return it to.
   */
  onCloseFocus: () => void
}

function Body({ view, column }: { view: CellView; column: ColumnMeta }): ReactNode {
  switch (view.kind) {
    case 'null':
      return (
        <p className="flex items-center gap-2 text-sm">
          This value is <CellToken view={view} />.
        </p>
      )
    case 'empty':
      return (
        <p className="flex items-center gap-2 text-sm">
          This value is an empty string <CellToken view={view} />.
        </p>
      )
    case 'masked':
      return (
        <p className="text-sm text-foreground-light">
          The server masks this column, so it sends no value.
        </p>
      )
    case 'missing':
      return <p className="text-sm text-foreground-light">The row has no value for this column.</p>
    case 'text': {
      const text = column.kind === 'json' ? prettyJson(view.full) : view.full
      const characters = codePointCount(view.full)
      return (
        <div className="flex flex-col gap-3">
          {view.serverCut !== undefined && (
            <Alert variant="warning">
              <AlertTitle>The server cut this value</AlertTitle>
              <AlertDescription>
                {`It kept the first part, shown below, of a value of ${formatCount(view.serverCut.size)} ${view.serverCut.unit}. The rest is not available here.`}
              </AlertDescription>
            </Alert>
          )}
          <p className="text-xs text-foreground-lighter">
            {`${formatCount(characters)} ${characters === 1 ? 'character' : 'characters'}`}
            {view.serverCut === undefined ? '' : ' held by the grid'}
          </p>
          <UntrustedText
            text={text}
            mono
            maxCodePoints={SHEET_CODE_POINTS}
            maxLines={SHEET_LINES}
            label="value"
          />
        </div>
      )
    }
  }
}

/**
 * The whole value of one cell in a side sheet: text only (invisible and
 * direction characters shown by code point), monospace, with a copy button. A
 * value the server cut says so and shows the part the grid holds. JSON is
 * re-indented without changing a digit.
 */
export function FullValueSheet({
  open,
  onOpenChange,
  column,
  row,
  view,
  onCopy,
  onCloseFocus,
}: FullValueSheetProps): ReactNode {
  const copyable = view?.kind === 'text'
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        size="w656"
        className="flex flex-col gap-0"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseFocus()
        }}
      >
        <SheetHeader>
          <SheetTitle>Full value</SheetTitle>
          <SheetDescription>
            {column === undefined ? (
              `Row ${row}`
            ) : (
              <>
                {`Row ${row}, column `}
                <UntrustedName name={column.name} mono label="column name" />
                {' of type '}
                <UntrustedName name={column.type} mono label="column type" />
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {view !== undefined && column !== undefined && <Body view={view} column={column} />}
        </div>
        <SheetFooter>
          <Button
            type="button"
            variant="outline"
            icon={<Copy />}
            disabled={!copyable}
            onClick={onCopy}
          >
            Copy value
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
