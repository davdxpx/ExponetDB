import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Slider } from '../src/slider.tsx'
import { axeViolations } from './support/axe.ts'

describe('Slider', () => {
  it('is one named slider thumb that moves with the arrow keys', async () => {
    const onValueChange = vi.fn()
    render(
      <Slider
        aria-label="Connection limit"
        defaultValue={[10]}
        max={20}
        onValueChange={onValueChange}
      />,
    )

    const thumb = screen.getByRole('slider', { name: 'Connection limit' })
    expect(thumb).toHaveAttribute('aria-valuenow', '10')
    expect(thumb).toHaveAttribute('aria-valuemin', '0')
    expect(thumb).toHaveAttribute('aria-valuemax', '20')
    expect(await axeViolations()).toEqual([])

    await userEvent.tab()
    expect(thumb).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(onValueChange).toHaveBeenLastCalledWith([11])
    await userEvent.keyboard('{Home}')
    expect(onValueChange).toHaveBeenLastCalledWith([0])
  })

  it('renders one thumb per value and names each from thumbLabels', async () => {
    render(
      <Slider
        defaultValue={[2, 8]}
        max={10}
        thumbLabels={['Minimum pool size', 'Maximum pool size']}
      />,
    )

    expect(screen.getAllByRole('slider').map((thumb) => thumb.getAttribute('aria-label'))).toEqual([
      'Minimum pool size',
      'Maximum pool size',
    ])
    expect(await axeViolations()).toEqual([])
  })

  it('uses the labelling element of a single thumb', () => {
    render(
      <>
        <span id="limit-label">Connection limit</span>
        <Slider aria-labelledby="limit-label" defaultValue={[5]} />
      </>,
    )

    expect(screen.getByRole('slider', { name: 'Connection limit' })).toBeInTheDocument()
  })

  it('has one thumb at the minimum when it has no value at all', () => {
    render(<Slider aria-label="Level" min={3} />)

    const thumbs = screen.getAllByRole('slider')
    expect(thumbs).toHaveLength(1)
    expect(thumbs[0]).toHaveAttribute('aria-valuenow', '3')
  })

  it('follows a controlled value and ignores the keyboard when disabled', async () => {
    const onValueChange = vi.fn()
    render(<Slider aria-label="Level" value={[40]} disabled onValueChange={onValueChange} />)

    const thumb = screen.getByRole('slider', { name: 'Level' })
    expect(thumb).toHaveAttribute('aria-valuenow', '40')
    expect(thumb).toHaveAttribute('data-disabled')
    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
