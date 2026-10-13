import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
  REGEXP_ONLY_DIGITS_AND_CHARS,
} from '../src/input-otp.tsx'
import { axeViolations } from './support/axe.ts'

// The library probes the pixel next to the input for a password manager badge; jsdom has no layout.
beforeAll(() => {
  document.elementFromPoint = () => null
})

// Unmount before the shared setup clears the document: the library's timers are cleared on unmount.
afterEach(cleanup)

type CodeProps = {
  maxLength?: number
  pattern?: string
  disabled?: boolean
  onChange?: (value: string) => void
  onComplete?: (value: string) => void
}

const renderCode = ({ maxLength = 6, ...props }: CodeProps = {}) =>
  render(
    <InputOTP maxLength={maxLength} aria-label="Verification code" {...props}>
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>,
  )

describe('InputOTP', () => {
  it('is one named text box that shows its characters in slots', async () => {
    const { container } = renderCode()

    const input = screen.getByRole('textbox', { name: 'Verification code' })
    await userEvent.type(input, '123')
    expect(input).toHaveValue('123')
    expect(container.textContent).toContain('123')
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('reports the value on every change and on completion', async () => {
    const onChange = vi.fn()
    const onComplete = vi.fn()
    renderCode({ onChange, onComplete })

    await userEvent.type(screen.getByRole('textbox'), '123456')
    expect(onChange).toHaveBeenLastCalledWith('123456')
    expect(onComplete).toHaveBeenCalledWith('123456')
  })

  it('keeps out characters the pattern does not allow', async () => {
    renderCode({ pattern: '^[0-9]+$' })

    const input = screen.getByRole('textbox')
    await userEvent.type(input, '1a2b3')
    expect(input).toHaveValue('123')
  })

  it('exports the pattern for letters and digits', () => {
    expect(new RegExp(REGEXP_ONLY_DIGITS_AND_CHARS).test('a1B2')).toBe(true)
    expect(new RegExp(REGEXP_ONLY_DIGITS_AND_CHARS).test('a-1')).toBe(false)
  })

  it('creates no <style> element and leaves a marker so the library skips its own', () => {
    renderCode()

    expect(document.querySelectorAll('style')).toHaveLength(0)
    const marker = document.getElementById('input-otp-style')
    expect(marker?.tagName).toBe('META')
  })

  it('renders no <noscript><style> fallback', () => {
    const { container } = renderCode()

    expect(container.querySelector('noscript')).toBeNull()
  })

  it('does not add a second marker for a second field', () => {
    render(
      <>
        <InputOTP maxLength={2} aria-label="First">
          <InputOTPSlot index={0} />
        </InputOTP>
        <InputOTP maxLength={2} aria-label="Second">
          <InputOTPSlot index={0} />
        </InputOTP>
      </>,
    )

    expect(document.querySelectorAll('#input-otp-style')).toHaveLength(1)
  })

  it('does not accept input when disabled', async () => {
    renderCode({ disabled: true })

    const input = screen.getByRole('textbox')
    expect(input).toBeDisabled()
    await userEvent.type(input, '1')
    expect(input).toHaveValue('')
  })

  it('renders nothing for a slot beyond the length', () => {
    render(
      <InputOTP maxLength={2} aria-label="Code">
        <InputOTPSlot index={0} data-testid="inside" />
        <InputOTPSlot index={5} data-testid="outside" />
      </InputOTP>,
    )

    expect(screen.getByTestId('inside')).toBeInTheDocument()
    expect(screen.queryByTestId('outside')).not.toBeInTheDocument()
  })
})
