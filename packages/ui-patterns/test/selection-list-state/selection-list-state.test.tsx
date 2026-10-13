// Derived from supabase/supabase packages/ui-patterns/src/SelectionListState/SelectionListState.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SelectionListState } from '../../src/selection-list-state/selection-list-state.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('SelectionListState', () => {
  it('keeps one persistent live region while its state changes', () => {
    const { container, rerender } = render(<SelectionListState isLoading />)

    const liveRegion = container.querySelector('[aria-live="polite"]')
    expect(liveRegion).not.toBeNull()
    if (!liveRegion) throw new Error('Expected an aria-live status region')
    expect(liveRegion).toHaveAttribute('aria-live', 'polite')
    expect(liveRegion).toHaveClass('sr-only')
    expect(liveRegion).toHaveTextContent('Loading options')

    rerender(<SelectionListState isEmpty emptyLabel="No columns found" />)

    expect(screen.getByText('No columns found')).toBe(liveRegion)
    expect(liveRegion).not.toHaveClass('sr-only')
  })

  it('shows the placeholder rows only while loading', () => {
    const { container, rerender } = render(
      <SelectionListState isLoading skeletonVariant="select" />,
    )

    expect(container.querySelector('.shimmering-loader')).toBeInTheDocument()

    rerender(<SelectionListState isEmpty />)

    expect(container.querySelector('.shimmering-loader')).not.toBeInTheDocument()
  })

  it('says the read failed, not that there are no options', () => {
    render(<SelectionListState isError errorLabel="Could not read the columns" />)

    expect(screen.getByText('Could not read the columns')).toBeVisible()
    expect(screen.queryByText('No options available')).not.toBeInTheDocument()
  })

  it('never shows the empty label for a failed read, even if the caller also reports empty', () => {
    render(<SelectionListState isError isEmpty emptyLabel="No columns found" />)

    expect(screen.queryByText('No columns found')).not.toBeInTheDocument()
    expect(screen.getByText('Could not read the options')).toBeVisible()
  })

  it('shows the loading label before the failed or empty ones', () => {
    render(<SelectionListState isLoading isError isEmpty />)

    expect(screen.getByText('Loading options')).toBeInTheDocument()
    expect(screen.queryByText('Could not read the options')).not.toBeInTheDocument()
    expect(screen.queryByText('No options available')).not.toBeInTheDocument()
  })

  it('shows the empty label only when told the read succeeded and found nothing', () => {
    const { container, rerender } = render(<SelectionListState />)

    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('')
    expect(container.querySelector('[aria-live="polite"]')).toHaveClass('sr-only')

    rerender(<SelectionListState isEmpty />)

    expect(screen.getByText('No options available')).toBeVisible()
  })

  it('has no accessibility violations in any state', async () => {
    const { container, rerender } = render(<SelectionListState isLoading />)
    expect(await axeViolations(container)).toEqual([])
    rerender(<SelectionListState isError />)
    expect(await axeViolations(container)).toEqual([])
    rerender(<SelectionListState isEmpty />)
    expect(await axeViolations(container)).toEqual([])
  })
})
