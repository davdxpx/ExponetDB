import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

import { Textarea } from '../src/textarea.tsx'
import { axeViolations } from './support/axe.ts'

describe('Textarea', () => {
  it('is a labelled multi-line text box and takes typed text', async () => {
    render(
      <>
        <label htmlFor="notes">Notes</label>
        <Textarea id="notes" />
      </>,
    )

    const textarea = screen.getByRole('textbox', { name: 'Notes' })
    await userEvent.type(textarea, 'line one{Enter}line two')
    expect(textarea).toHaveValue('line one\nline two')
    expect(await axeViolations()).toEqual([])
  })

  it('is disabled and not typeable when disabled', async () => {
    render(<Textarea aria-label="Notes" disabled />)

    const textarea = screen.getByRole('textbox')
    expect(textarea).toBeDisabled()
    await userEvent.type(textarea, 'x')
    expect(textarea).toHaveValue('')
    expect(await axeViolations()).toEqual([])
  })

  it('marks an invalid textarea with aria-invalid and styles it from that attribute', () => {
    render(<Textarea aria-label="Notes" aria-invalid="true" />)

    const textarea = screen.getByRole('textbox')
    expect(textarea).toBeInvalid()
    expect(textarea).toHaveClass('aria-[invalid=true]:border-destructive-400')
  })

  it('forwards its ref and merges a className', () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(<Textarea ref={ref} aria-label="Notes" className="min-h-[160px]" />)

    expect(ref.current).toBe(screen.getByRole('textbox'))
    expect(ref.current).toHaveClass('min-h-[160px]')
    expect(ref.current).not.toHaveClass('min-h-[80px]')
  })
})
