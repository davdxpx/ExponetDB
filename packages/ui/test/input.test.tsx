import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Input, inputVariants } from '../src/input.tsx'
import { axeViolations } from './support/axe.ts'

const SIZES = {
  tiny: 'h-[26px]',
  small: 'h-[34px]',
  medium: 'h-[38px]',
  large: 'h-[42px]',
} as const

describe('Input', () => {
  it('is a labelled text box and takes typed text', async () => {
    const onChange = vi.fn()
    render(
      <>
        <label htmlFor="name">Target name</label>
        <Input id="name" onChange={onChange} />
      </>,
    )

    const input = screen.getByRole('textbox', { name: 'Target name' })
    await userEvent.type(input, 'prod')
    expect(input).toHaveValue('prod')
    expect(onChange).toHaveBeenCalledTimes(4)
    expect(await axeViolations()).toEqual([])
  })

  it('defaults to the small size', () => {
    render(<Input aria-label="Name" />)

    expect(screen.getByRole('textbox')).toHaveClass(SIZES.small)
  })

  for (const [size, marker] of Object.entries(SIZES)) {
    it(`renders the ${size} size`, () => {
      render(<Input aria-label="Name" size={size as keyof typeof SIZES} />)

      expect(screen.getByRole('textbox')).toHaveClass(marker)
    })
  }

  it('shares its sizes with the class helper', () => {
    expect(inputVariants({ size: 'tiny' })).toContain('h-[26px]')
    expect(inputVariants()).toContain('h-[34px]')
  })

  it('does not take focus or text when disabled', async () => {
    render(<Input aria-label="Name" disabled />)

    const input = screen.getByRole('textbox')
    expect(input).toBeDisabled()
    await userEvent.type(input, 'x')
    expect(input).toHaveValue('')
    expect(await axeViolations()).toEqual([])
  })

  it('marks an invalid input with aria-invalid and styles it from that attribute', async () => {
    render(
      <>
        <Input aria-label="Name" aria-invalid="true" aria-describedby="why" />
        <p id="why">Name is required.</p>
      </>,
    )

    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription('Name is required.')
    expect(input).toHaveClass('aria-[invalid=true]:border-destructive-400')
    expect(await axeViolations()).toEqual([])
  })

  it('is read-only without being disabled', async () => {
    render(<Input aria-label="Plan hash" readOnly value="sha256:abc" />)

    const input = screen.getByRole('textbox', { name: 'Plan hash' })
    expect(input).toHaveAttribute('readonly')
    expect(input).not.toBeDisabled()
    await userEvent.type(input, 'x')
    expect(input).toHaveValue('sha256:abc')
  })

  it('forwards its ref and merges a className', () => {
    const ref = createRef<HTMLInputElement>()
    render(<Input ref={ref} aria-label="Name" className="w-64" />)

    expect(ref.current).toBe(screen.getByRole('textbox'))
    expect(ref.current).toHaveClass('w-64')
    expect(ref.current).not.toHaveClass('w-full')
  })
})
