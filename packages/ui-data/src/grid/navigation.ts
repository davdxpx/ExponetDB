/**
 * Keyboard movement in the grid. Positions are in grid coordinates: row 0 is
 * the header row, rows 1 to N are the data rows; columns count from 0.
 */
export interface GridPosition {
  readonly row: number
  readonly col: number
}

export interface GridBounds {
  /** Number of data rows (the header row is extra). */
  readonly rows: number
  readonly columns: number
  /** Data rows that fit in the scrolling region, for PageUp and PageDown. */
  readonly pageSize: number
}

export interface NavigationKey {
  readonly key: string
  /** Control or Command. */
  readonly ctrl: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Where a key moves the focus, or `null` when the key does not move it. The
 * movement stops at the edges (it does not wrap). Home and End go to the first
 * and last column of the row; with Control they go to the first and last cell
 * of the grid. PageUp and PageDown move by a page of rows.
 */
export function nextPosition(
  from: GridPosition,
  input: NavigationKey,
  bounds: GridBounds,
): GridPosition | null {
  const lastRow = Math.max(0, bounds.rows)
  const lastCol = Math.max(0, bounds.columns - 1)
  const page = Math.max(1, Math.floor(bounds.pageSize))
  const at = (row: number, col: number): GridPosition => ({
    row: clamp(row, 0, lastRow),
    col: clamp(col, 0, lastCol),
  })
  switch (input.key) {
    case 'ArrowUp':
      return at(from.row - 1, from.col)
    case 'ArrowDown':
      return at(from.row + 1, from.col)
    case 'ArrowLeft':
      return at(from.row, from.col - 1)
    case 'ArrowRight':
      return at(from.row, from.col + 1)
    case 'PageUp':
      return at(from.row - page, from.col)
    case 'PageDown':
      return at(from.row + page, from.col)
    case 'Home':
      return input.ctrl ? at(0, 0) : at(from.row, 0)
    case 'End':
      return input.ctrl ? at(lastRow, lastCol) : at(from.row, lastCol)
    default:
      return null
  }
}
