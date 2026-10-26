import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clampPage, Pager, type PagerText, pageCount, pageSlice } from '../../src/pager/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const text: PagerText = {
  previous: 'Previous',
  next: 'Next',
  range: (from, to, total) => `${from}–${to} of ${total}`,
  page: (page, pages) => `Page ${page} of ${pages}`,
  pageSize: 'Rows per page',
}

describe('page arithmetic', () => {
  it('counts at least one page, also for no items', () => {
    expect(pageCount(0, 25)).toBe(1)
    expect(pageCount(25, 25)).toBe(1)
    expect(pageCount(26, 25)).toBe(2)
    expect(pageCount(512, 50)).toBe(11)
    expect(pageCount(10, 0)).toBe(1)
    expect(pageCount(Number.NaN, 25)).toBe(1)
  })

  it('clamps a deep link past the end to the last page and nonsense to the first', () => {
    expect(clampPage(99, 512, 50)).toBe(11)
    expect(clampPage(0, 512, 50)).toBe(1)
    expect(clampPage(-3, 512, 50)).toBe(1)
    expect(clampPage(Number.NaN, 512, 50)).toBe(1)
    expect(clampPage(2.7, 512, 50)).toBe(2)
  })

  it('slices one page with its 1-based range', () => {
    const items = Array.from({ length: 512 }, (_, i) => i)
    const third = pageSlice(items, 3, 50)
    expect(third.items).toHaveLength(50)
    expect(third.items[0]).toBe(100)
    expect([third.from, third.to, third.page]).toEqual([101, 150, 3])
    const last = pageSlice(items, 400, 50)
    expect([last.from, last.to, last.page, last.items.length]).toEqual([501, 512, 11, 12])
    const none = pageSlice([], 1, 50)
    expect([none.from, none.to, none.page, none.items.length]).toEqual([0, 0, 1, 0])
  })
})

describe('Pager', () => {
  it('names its landmark, announces the range and moves page by page', async () => {
    const onPage = vi.fn()
    render(
      <Pager
        label="History pages"
        page={2}
        pageSize={50}
        total={512}
        onPage={onPage}
        text={text}
      />,
    )
    const nav = screen.getByRole('navigation', { name: 'History pages' })
    expect(nav).toHaveTextContent('51–100 of 512')
    expect(nav).toHaveTextContent('Page 2 of 11')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(onPage.mock.calls).toEqual([[3], [1]])
  })

  it('disables the buttons at the ends instead of removing them', () => {
    const { rerender } = render(
      <Pager label="Pages" page={1} pageSize={25} total={10} onPage={() => {}} text={text} />,
    )
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    rerender(<Pager label="Pages" page={1} pageSize={25} total={0} onPage={() => {}} text={text} />)
    expect(screen.getByRole('navigation')).toHaveTextContent('0–0 of 0')
  })

  it('offers the page size with a label when the caller lets it change', async () => {
    const onPageSize = vi.fn()
    render(
      <Pager
        label="Pages"
        page={1}
        pageSize={25}
        total={300}
        onPage={() => {}}
        onPageSize={onPageSize}
        text={text}
        note="All 300 entries come from one read."
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Rows per page'), '100')
    expect(onPageSize).toHaveBeenCalledWith(100)
    expect(screen.getByText('All 300 entries come from one read.')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <Pager
        label="Pages"
        page={3}
        pageSize={25}
        total={300}
        onPage={() => {}}
        onPageSize={() => {}}
        text={text}
      />,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
