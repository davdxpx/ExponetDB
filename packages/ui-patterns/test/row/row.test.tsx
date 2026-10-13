import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isItemVisible, Row } from '../../src/row/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** jsdom has no layout: give every element a width so the row can measure itself. */
function mockWidth(width: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
}

function cards(count: number) {
  return ['1', '2', '3', '4', '5', '6'].slice(0, count).map((n) => (
    <a key={n} href={`/targets/${n}`}>
      Card {n}
    </a>
  ))
}

describe('isItemVisible', () => {
  const base = { viewportWidth: 600, columnWidth: 292, gap: 16 }

  it('counts the items inside the viewport', () => {
    expect(isItemVisible({ ...base, index: 0, scrollPosition: 0 })).toBe(true)
    expect(isItemVisible({ ...base, index: 1, scrollPosition: 0 })).toBe(true)
    expect(isItemVisible({ ...base, index: 2, scrollPosition: 0 })).toBe(false)
  })

  it('follows the scroll position', () => {
    expect(isItemVisible({ ...base, index: 0, scrollPosition: 308 })).toBe(false)
    expect(isItemVisible({ ...base, index: 2, scrollPosition: 308 })).toBe(true)
  })
})

describe('Row', () => {
  beforeEach(() => mockWidth(600))

  it('is a named region that holds every item', () => {
    render(
      <Row maxColumns={3} minWidth={280} label="Recent plans">
        {cards(3)}
      </Row>,
    )

    const region = screen.getByRole('region', { name: 'Recent plans' })
    expect(region).toHaveAttribute('aria-roledescription', 'carousel')
    expect(region).toHaveAttribute('tabindex', '0')
    expect(screen.getAllByText(/^Card /, { selector: 'a' })).toHaveLength(3)
  })

  it('starts at the first column, not shifted', () => {
    const { container } = render(
      <Row maxColumns={3} minWidth={280}>
        {cards(4)}
      </Row>,
    )

    const track = container.querySelector('section > div')
    expect(track).toHaveStyle({ transform: 'translateX(-0px)' })
  })

  it('has no arrows when everything fits', () => {
    render(
      <Row maxColumns={3} minWidth={180}>
        {cards(3)}
      </Row>,
    )

    expect(screen.queryByRole('button', { name: 'Scroll right' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Scroll left' })).not.toBeInTheDocument()
  })

  it('scrolls by a column with the arrow buttons and hides the ones with nothing to scroll to', async () => {
    const user = userEvent.setup()
    render(
      <Row maxColumns={3} minWidth={280}>
        {cards(4)}
      </Row>,
    )

    expect(screen.queryByRole('button', { name: 'Scroll left' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Scroll right' }))
    expect(screen.getByRole('button', { name: 'Scroll left' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Scroll right' }))
    expect(screen.queryByRole('button', { name: 'Scroll right' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Scroll left' }))
    expect(screen.getByRole('button', { name: 'Scroll right' })).toBeInTheDocument()
  })

  it('keeps items that are scrolled out of sight out of the tab order', async () => {
    const user = userEvent.setup()
    render(
      <Row maxColumns={3} minWidth={280}>
        {cards(4)}
      </Row>,
    )

    const wrapperOf = (name: string) => screen.getByText(name).parentElement
    expect(wrapperOf('Card 1')).not.toHaveAttribute('inert')
    expect(wrapperOf('Card 2')).not.toHaveAttribute('inert')
    expect(wrapperOf('Card 3')).toHaveAttribute('inert')

    await user.click(screen.getByRole('button', { name: 'Scroll right' }))

    expect(wrapperOf('Card 1')).toHaveAttribute('inert')
    expect(wrapperOf('Card 3')).not.toHaveAttribute('inert')
  })

  it('scrolls with the arrow keys on the focused region', async () => {
    const user = userEvent.setup()
    render(
      <Row maxColumns={3} minWidth={280} label="Cards">
        {cards(4)}
      </Row>,
    )

    screen.getByRole('region', { name: 'Cards' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'Scroll left' })).toBeInTheDocument()

    await user.keyboard('{ArrowLeft}')
    expect(screen.queryByRole('button', { name: 'Scroll left' })).not.toBeInTheDocument()
  })

  it('hides the arrows when asked to', () => {
    render(
      <Row maxColumns={3} minWidth={280} showArrows={false}>
        {cards(4)}
      </Row>,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('cancels a pending wheel frame when it unmounts', () => {
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(7)
    const { unmount } = render(
      <Row maxColumns={3} minWidth={280} label="Cards">
        {cards(4)}
      </Row>,
    )
    const region = screen.getByRole('region', { name: 'Cards' })

    act(() => {
      region.dispatchEvent(new WheelEvent('wheel', { deltaX: 40, deltaY: 0, bubbles: true }))
    })
    unmount()

    expect(cancel).toHaveBeenCalledWith(7)
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <Row maxColumns={3} minWidth={280} label="Recent plans">
        {cards(4)}
      </Row>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
