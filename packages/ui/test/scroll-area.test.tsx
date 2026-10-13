import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScrollArea, ScrollViewport } from '../src/scroll-area.tsx'
import { axeViolations } from './support/axe.ts'

describe('ScrollArea', () => {
  it('renders its children in a viewport and has no accessibility violations', async () => {
    render(
      <ScrollArea className="h-24" data-testid="area">
        <p>Migration log</p>
      </ScrollArea>,
    )

    expect(screen.getByTestId('area')).toHaveClass('relative', 'overflow-hidden', 'h-24')
    expect(
      screen.getByText('Migration log').closest('[data-radix-scroll-area-viewport]'),
    ).not.toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('hides the native scrollbar through the style prop, since the style element Radix renders is blocked by the CSP', () => {
    render(
      <ScrollArea>
        <p>content</p>
      </ScrollArea>,
    )

    const viewport = document.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')
    expect(viewport?.style.scrollbarWidth).toBe('none')
    // Radix still writes its own overflow rules next to ours
    expect(viewport?.style.overflowY).toBe('scroll')
  })

  it('keeps the style of a nested viewport next to the hidden scrollbar', () => {
    render(
      <ScrollArea>
        <ScrollViewport style={{ maxHeight: '10rem' }} data-testid="viewport">
          <p>content</p>
        </ScrollViewport>
      </ScrollArea>,
    )

    const viewport = screen.getByTestId('viewport')
    expect(viewport.style.maxHeight).toBe('10rem')
    expect(viewport.style.scrollbarWidth).toBe('none')
  })

  it('offers the scrollbars asked for', () => {
    const { container } = render(
      <ScrollArea orientation="both" type="always">
        <p>content</p>
      </ScrollArea>,
    )

    expect(container.querySelector('[data-orientation="vertical"]')).not.toBeNull()
    expect(container.querySelector('[data-orientation="horizontal"]')).not.toBeNull()
  })

  it('adds no style element; the one Radix renders is the rule the static stylesheet must carry', () => {
    render(
      <ScrollArea>
        <p>content</p>
      </ScrollArea>,
    )

    // Pins the rule of @radix-ui/react-scroll-area: if an upgrade changes it, the static
    // stylesheet of the Web App has to change with it.
    expect([...document.querySelectorAll('style')].map((element) => element.textContent)).toEqual([
      '[data-radix-scroll-area-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-scroll-area-viewport]::-webkit-scrollbar{display:none}',
    ])
  })
})
