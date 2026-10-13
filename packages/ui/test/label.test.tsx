import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Label } from '../src/label.tsx'
import { axeViolations } from './support/axe.ts'

describe('Label', () => {
  it('names the control it points at and focuses it on click', async () => {
    render(
      <>
        <Label htmlFor="target-name">Target name</Label>
        <input id="target-name" />
      </>,
    )

    const input = screen.getByLabelText('Target name')
    expect(input).toBe(screen.getByRole('textbox'))
    await userEvent.click(screen.getByText('Target name'))
    expect(input).toHaveFocus()
    expect(await axeViolations()).toEqual([])
  })

  it('dims itself when its peer control is disabled and merges a className', () => {
    render(<Label className="font-medium">Environment</Label>)

    const label = screen.getByText('Environment')
    expect(label).toHaveClass('peer-disabled:opacity-70', 'peer-disabled:cursor-not-allowed')
    expect(label).toHaveClass('font-medium')
  })

  it('has no stray "text" utility class', () => {
    render(<Label>Environment</Label>)

    expect(screen.getByText('Environment').classList.contains('text')).toBe(false)
  })
})
