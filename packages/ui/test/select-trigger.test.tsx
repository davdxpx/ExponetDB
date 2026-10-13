import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ComboboxTrigger } from '../src/combobox-trigger.tsx'
import { selectTriggerVariants } from '../src/select-trigger.tsx'
import { axeViolations } from './support/axe.ts'

const SIZES = {
  tiny: 'h-[26px]',
  small: 'h-[34px]',
  medium: 'h-[38px]',
  large: 'h-[42px]',
} as const

describe('selectTriggerVariants', () => {
  it('defaults to the small size, like Input', () => {
    expect(selectTriggerVariants()).toContain('h-[34px]')
  })

  for (const [size, marker] of Object.entries(SIZES)) {
    it(`gives the ${size} size the height of the Button and Input of that size`, () => {
      const classes = selectTriggerVariants({ size: size as keyof typeof SIZES })
      expect(classes).toContain(marker)
      expect(classes).toContain('raised-control-surface')
      expect(classes).toContain('focus-ring')
    })
  }

  it('styles an invalid trigger from aria-invalid', () => {
    expect(selectTriggerVariants()).toContain('aria-[invalid=true]:border-destructive-400')
  })
})

describe('ComboboxTrigger', () => {
  it('is a named combobox button without accessibility violations', async () => {
    render(
      <ComboboxTrigger aria-label="Publication" aria-expanded={false} aria-haspopup="listbox">
        Choose a publication
      </ComboboxTrigger>,
    )

    const trigger = screen.getByRole('combobox', { name: 'Publication' })
    expect(trigger).toHaveAttribute('type', 'button')
    expect(trigger).toHaveTextContent('Choose a publication')
    expect(await axeViolations()).toEqual([])
  })

  it('leaves the tab order when disabled and keeps an explicit tabIndex', () => {
    render(
      <>
        <ComboboxTrigger aria-label="Off" aria-expanded={false} disabled>
          Off
        </ComboboxTrigger>
        <ComboboxTrigger aria-label="Explicit" aria-expanded={false} tabIndex={-1}>
          Explicit
        </ComboboxTrigger>
        <ComboboxTrigger aria-label="On" aria-expanded={false}>
          On
        </ComboboxTrigger>
      </>,
    )

    expect(screen.getByRole('combobox', { name: 'Off' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('combobox', { name: 'Explicit' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('combobox', { name: 'On' })).toHaveAttribute('tabindex', '0')
  })
})
