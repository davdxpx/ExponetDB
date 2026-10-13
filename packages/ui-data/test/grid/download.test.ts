import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { downloadText, OBJECT_URL_LIFETIME_MS } from '../../src/grid/download.ts'

describe('downloadText', () => {
  const created: Blob[] = []
  let clicked: HTMLAnchorElement[] = []

  beforeEach(() => {
    created.length = 0
    clicked = []
    vi.useFakeTimers()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        created.push(blob)
        return 'blob:test/1'
      }),
      revokeObjectURL: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('clicks a download link to an object URL, removes it, and revokes the URL later', () => {
    downloadText('a,b\r\n', 'result.csv', 'text/csv;charset=utf-8')

    expect(created).toHaveLength(1)
    expect(created[0]?.type).toBe('text/csv;charset=utf-8')
    expect(created[0]?.size).toBe(5)
    expect(clicked).toHaveLength(1)
    expect(clicked[0]?.download).toBe('result.csv')
    expect(clicked[0]?.getAttribute('href')).toBe('blob:test/1')
    expect(document.querySelector('a[download]')).toBeNull()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()

    vi.advanceTimersByTime(OBJECT_URL_LIFETIME_MS)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1')
  })

  it('never opens a window', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    downloadText('x', 'result.json', 'application/json')
    expect(open).not.toHaveBeenCalled()
  })

  it('removes the link and still revokes the URL when the click throws', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => downloadText('x', 'result.csv', 'text/csv')).toThrow('blocked')
    expect(document.querySelector('a[download]')).toBeNull()
    vi.advanceTimersByTime(OBJECT_URL_LIFETIME_MS)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1')
  })
})
