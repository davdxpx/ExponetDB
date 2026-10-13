import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Progress } from '../src/progress.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const fill = () => screen.getByRole('progressbar').firstElementChild as HTMLElement

describe('Progress', () => {
  it('is a named progress bar with its value', () => {
    render(<Progress aria-label="Backup upload" value={40} />)

    const bar = screen.getByRole('progressbar', { name: 'Backup upload' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('data-state', 'loading')
    expect(fill().style.transform).toBe('translateX(-60%)')
  })

  it.each([
    [0, 'translateX(-100%)'],
    [100, 'translateX(-0%)'],
    [150, 'translateX(-0%)'],
    [-20, 'translateX(-100%)'],
  ])('clamps the fill: value %s', (value, transform) => {
    render(<Progress aria-label="Upload" value={value} />)

    expect(fill().style.transform).toBe(transform)
  })

  it('scales the fill by max', () => {
    render(<Progress aria-label="Verified migrations" value={3} max={12} />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '12')
    expect(fill().style.transform).toBe('translateX(-75%)')
  })

  it('is indeterminate without a value: busy, not done', () => {
    render(<Progress aria-label="Restore in progress" />)

    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('data-state', 'indeterminate')
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(fill()).toHaveClass('data-[state=indeterminate]:motion-safe:animate-pulse')
    expect(fill().style.transform).toBe('translateX(-65%)')
  })

  it('shows a completed bar as complete', () => {
    render(<Progress aria-label="Upload" value={100} />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('data-state', 'complete')
  })

  it('has no axe violations determinate and indeterminate', async () => {
    render(
      <>
        <Progress aria-label="Upload" value={25} />
        <Progress aria-label="Restore in progress" />
      </>,
    )

    expect(await axeViolations()).toEqual([])
  })
})
