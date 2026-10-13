import { describe, expect, it } from 'vitest'

import { type GridBounds, nextPosition } from '../../src/grid/navigation.ts'

const bounds: GridBounds = { rows: 20, columns: 5, pageSize: 8 }
const press = (row: number, col: number, key: string, ctrl = false) =>
  nextPosition({ row, col }, { key, ctrl }, bounds)

describe('nextPosition', () => {
  it('moves one cell with the arrows', () => {
    expect(press(5, 2, 'ArrowUp')).toEqual({ row: 4, col: 2 })
    expect(press(5, 2, 'ArrowDown')).toEqual({ row: 6, col: 2 })
    expect(press(5, 2, 'ArrowLeft')).toEqual({ row: 5, col: 1 })
    expect(press(5, 2, 'ArrowRight')).toEqual({ row: 5, col: 3 })
  })

  it('stops at the edges and does not wrap', () => {
    expect(press(0, 0, 'ArrowUp')).toEqual({ row: 0, col: 0 })
    expect(press(0, 0, 'ArrowLeft')).toEqual({ row: 0, col: 0 })
    expect(press(20, 4, 'ArrowDown')).toEqual({ row: 20, col: 4 })
    expect(press(20, 4, 'ArrowRight')).toEqual({ row: 20, col: 4 })
  })

  it('reaches the header row, row 0, from the first data row', () => {
    expect(press(1, 3, 'ArrowUp')).toEqual({ row: 0, col: 3 })
  })

  it('goes to the first and last column with Home and End', () => {
    expect(press(7, 3, 'Home')).toEqual({ row: 7, col: 0 })
    expect(press(7, 1, 'End')).toEqual({ row: 7, col: 4 })
  })

  it('goes to the first and last cell of the grid with Control', () => {
    expect(press(7, 3, 'Home', true)).toEqual({ row: 0, col: 0 })
    expect(press(7, 1, 'End', true)).toEqual({ row: 20, col: 4 })
  })

  it('moves a page with PageUp and PageDown and stops at the edges', () => {
    expect(press(10, 2, 'PageDown')).toEqual({ row: 18, col: 2 })
    expect(press(15, 2, 'PageDown')).toEqual({ row: 20, col: 2 })
    expect(press(10, 2, 'PageUp')).toEqual({ row: 2, col: 2 })
    expect(press(3, 2, 'PageUp')).toEqual({ row: 0, col: 2 })
  })

  it('ignores other keys', () => {
    expect(press(5, 2, 'a')).toBeNull()
    expect(press(5, 2, 'Enter')).toBeNull()
    expect(press(5, 2, 'Tab')).toBeNull()
  })

  it('copes with an empty grid and a page of zero', () => {
    const empty: GridBounds = { rows: 0, columns: 0, pageSize: 0 }
    expect(nextPosition({ row: 0, col: 0 }, { key: 'ArrowDown', ctrl: false }, empty)).toEqual({
      row: 0,
      col: 0,
    })
    expect(nextPosition({ row: 0, col: 0 }, { key: 'PageDown', ctrl: false }, empty)).toEqual({
      row: 0,
      col: 0,
    })
  })
})
