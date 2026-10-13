import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Switch } from '../src/switch.tsx'
import { axeViolations } from './support/axe.ts'

describe('Switch', () => {
  it('is a labelled switch that toggles with a click and the Space key', async () => {
    const onCheckedChange = vi.fn()
    render(
      <>
        <Switch id="notify" onCheckedChange={onCheckedChange} />
        <label htmlFor="notify">Notify on failure</label>
      </>,
    )

    const toggle = screen.getByRole('switch', { name: 'Notify on failure' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(onCheckedChange).toHaveBeenLastCalledWith(true)

    await userEvent.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(await axeViolations()).toEqual([])
  })

  it('starts on with defaultChecked', () => {
    render(<Switch aria-label="Enabled" defaultChecked />)

    expect(screen.getByRole('switch')).toBeChecked()
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'checked')
  })

  for (const [size, marker] of Object.entries({
    small: 'h-[16px]',
    medium: 'h-[20px]',
    large: 'h-[24px]',
  })) {
    it(`renders the ${size} size`, () => {
      render(<Switch aria-label={size} size={size as 'small' | 'medium' | 'large'} />)

      expect(screen.getByRole('switch')).toHaveClass(marker)
    })
  }

  it('defaults to the medium size', () => {
    render(<Switch aria-label="Default" />)

    expect(screen.getByRole('switch')).toHaveClass('h-[20px]', 'w-[34px]')
  })

  it('ignores clicks when disabled', async () => {
    const onCheckedChange = vi.fn()
    render(<Switch aria-label="Locked" disabled onCheckedChange={onCheckedChange} />)

    const toggle = screen.getByRole('switch')
    expect(toggle).toBeDisabled()
    await userEvent.click(toggle)
    expect(onCheckedChange).not.toHaveBeenCalled()
    expect(await axeViolations()).toEqual([])
  })
})
