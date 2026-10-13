// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/toggle.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Toggle } from '../src/toggle.tsx'
import { axeViolations } from './support/axe.ts'

describe('Toggle', () => {
  it('aligns its compact sizes with form controls', () => {
    const { rerender } = render(<Toggle size="tiny">Tiny</Toggle>)

    expect(screen.getByRole('button', { name: 'Tiny' })).toHaveClass('h-[26px]')

    rerender(<Toggle size="sm">Small</Toggle>)

    expect(screen.getByRole('button', { name: 'Small' })).toHaveClass('h-[34px]')
  })

  it('is a toggle button with aria-pressed that follows a click and the Space key', async () => {
    const onPressedChange = vi.fn()
    render(<Toggle onPressedChange={onPressedChange}>Wrap lines</Toggle>)

    const toggle = screen.getByRole('button', { name: 'Wrap lines' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('data-state', 'off')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('data-state', 'on')
    expect(onPressedChange).toHaveBeenLastCalledWith(true)

    await userEvent.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(await axeViolations()).toEqual([])
  })

  it('renders the default, outline and segmented variants', async () => {
    render(
      <>
        <Toggle variant="default">Default</Toggle>
        <Toggle variant="outline">Outline</Toggle>
        <Toggle variant="segmented">Segmented</Toggle>
      </>,
    )

    expect(screen.getByRole('button', { name: 'Outline' })).toHaveClass('border', 'border-control')
    expect(screen.getByRole('button', { name: 'Segmented' })).toHaveClass(
      'cursor-pointer',
      'rounded-sm',
    )
    expect(screen.getByRole('button', { name: 'Default' })).toHaveClass('focus-ring')
    expect(await axeViolations()).toEqual([])
  })

  it('renders every size', () => {
    render(
      <>
        <Toggle size="tiny">Tiny</Toggle>
        <Toggle size="sm">Small</Toggle>
        <Toggle size="default">Default</Toggle>
        <Toggle size="lg">Large</Toggle>
      </>,
    )

    expect(screen.getByRole('button', { name: 'Tiny' })).toHaveClass('h-[26px]')
    expect(screen.getByRole('button', { name: 'Small' })).toHaveClass('h-[34px]')
    expect(screen.getByRole('button', { name: 'Default' })).toHaveClass('h-10')
    expect(screen.getByRole('button', { name: 'Large' })).toHaveClass('h-11')
  })

  it('ignores clicks when disabled', async () => {
    const onPressedChange = vi.fn()
    render(
      <Toggle disabled onPressedChange={onPressedChange}>
        Locked
      </Toggle>,
    )

    const toggle = screen.getByRole('button', { name: 'Locked' })
    expect(toggle).toBeDisabled()
    await userEvent.click(toggle)
    expect(onPressedChange).not.toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })
})
