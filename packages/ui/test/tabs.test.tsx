// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/tabs.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from '../src/tabs.tsx'
import { axeViolations } from './support/axe.ts'

const renderTabs = ({ indicator = false } = {}) =>
  render(
    <Tabs defaultValue="one">
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
        {indicator ? <TabsIndicator /> : null}
      </TabsList>
      <TabsContent value="one">First</TabsContent>
      <TabsContent value="two">Second</TabsContent>
    </Tabs>,
  )

describe('Tabs', () => {
  it('borders each trigger when no indicator is rendered', () => {
    const { container } = renderTabs()

    expect(screen.getByRole('tab', { name: 'One' })).toHaveClass('border-b-2')
    expect(container.querySelector('[data-tab-indicator]')).toBeNull()
  })

  it('measures the active tab only for lists that render an indicator', async () => {
    const withoutIndicator = renderTabs().container.querySelector<HTMLElement>('[role="tablist"]')
    const withIndicator = renderTabs({ indicator: true }).container.querySelector<HTMLElement>(
      '[role="tablist"]',
    )

    await waitFor(() => expect(withIndicator?.dataset['tabIndicatorReady']).toBe(''))
    expect(withoutIndicator?.dataset['tabIndicatorReady']).toBeUndefined()
  })

  it('hides the underline when no trigger is active', async () => {
    const { container, rerender } = render(
      <Tabs value="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsIndicator />
        </TabsList>
        <TabsContent value="one">First</TabsContent>
      </Tabs>,
    )
    const list = container.querySelector<HTMLElement>('[role="tablist"]')
    await waitFor(() => expect(list?.dataset['tabIndicatorReady']).toBe(''))

    rerender(
      <Tabs value="gone">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsIndicator />
        </TabsList>
        <TabsContent value="one">First</TabsContent>
      </Tabs>,
    )

    await waitFor(() => expect(list?.dataset['tabIndicatorReady']).toBeUndefined())
  })

  it('renders the first trigger as the first element in the list', () => {
    const { container } = renderTabs({ indicator: true })

    expect(container.querySelector('[role="tablist"]')?.firstElementChild).toBe(
      screen.getByRole('tab', { name: 'One' }),
    )
  })

  it('passes a caller ref through to the list element', () => {
    const ref = { current: null as HTMLDivElement | null }

    render(
      <Tabs defaultValue="one">
        <TabsList ref={ref}>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">First</TabsContent>
      </Tabs>,
    )

    expect(ref.current).toBe(screen.getByRole('tablist'))
  })

  it('writes the indicator position as custom properties on the list (CSSOM), not as injected styles', async () => {
    const { container } = renderTabs({ indicator: true })
    const list = container.querySelector<HTMLElement>('[role="tablist"]')

    await waitFor(() => expect(list?.dataset['tabIndicatorReady']).toBe(''))
    expect(list?.style.getPropertyValue('--active-tab-left')).toBe('0px')
    expect(list?.style.getPropertyValue('--active-tab-width')).toBe('0px')
    expect(document.querySelector('style')).toBeNull()
    // the indicator itself carries no inline position: it reads the properties in CSS
    expect(container.querySelector('[data-tab-indicator]')?.getAttribute('style')).toBeNull()
  })

  it('exposes tab semantics and moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup()
    renderTabs({ indicator: true })

    const one = screen.getByRole('tab', { name: 'One' })
    const two = screen.getByRole('tab', { name: 'Two' })
    expect(one).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('First')
    expect(await axeViolations()).toEqual([])

    one.focus()
    await user.keyboard('{ArrowRight}')
    expect(two).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(two).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Second')
    expect(await axeViolations()).toEqual([])
  })

  it('hides the decorative indicator from assistive technology', () => {
    const { container } = renderTabs({ indicator: true })

    expect(container.querySelector('[data-tab-indicator]')).toHaveAttribute('aria-hidden', 'true')
  })
})
