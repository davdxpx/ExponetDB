// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/accordion.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../src/accordion.tsx'
import { axeViolations } from './support/axe.ts'

describe('AccordionTrigger', () => {
  it('fills its container without adding horizontal padding', () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="advanced">
          <AccordionTrigger>Advanced settings</AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    )

    const trigger = screen.getByRole('button', { name: 'Advanced settings' })
    expect(trigger.parentElement).toHaveClass('flex', 'w-full')
    expect(trigger).toHaveClass('flex-1', 'relative', 'focus-inset')
    expect(trigger).not.toHaveClass('px-2')
    expect(trigger).not.toHaveClass('rounded-md')
    expect(trigger).not.toHaveClass('focus-ring')
    expect(trigger).not.toHaveClass('transition-colors')
    expect(trigger).not.toHaveClass('transition-all')
  })

  it('supports an outer focus ring when explicitly requested', () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="advanced">
          <AccordionTrigger focusVariant="ring">Advanced settings</AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    )

    const trigger = screen.getByRole('button', { name: 'Advanced settings' })
    expect(trigger).toHaveClass('rounded-md', 'focus-ring')
    expect(trigger).not.toHaveClass('focus-inset')
  })

  it('wraps the trigger in a heading of the requested level', () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="advanced">
          <AccordionTrigger headingLevel={4}>Advanced settings</AccordionTrigger>
        </AccordionItem>
        <AccordionItem value="other">
          <AccordionTrigger>Other settings</AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    )

    expect(screen.getByRole('heading', { level: 4, name: 'Advanced settings' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Other settings' })).toBeInTheDocument()
  })

  it('opens and closes with the keyboard and states it in aria-expanded', async () => {
    const user = userEvent.setup()
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="advanced">
          <AccordionTrigger>Advanced settings</AccordionTrigger>
          <AccordionContent>Statement timeout</AccordionContent>
        </AccordionItem>
      </Accordion>,
    )

    const trigger = screen.getByRole('button', { name: 'Advanced settings' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Statement timeout')).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])

    trigger.focus()
    await user.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Statement timeout')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])

    await user.keyboard(' ')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('takes a disabled trigger out of the tab order', () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="advanced">
          <AccordionTrigger disabled>Advanced settings</AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    )

    expect(screen.getByRole('button', { name: 'Advanced settings' })).toBeDisabled()
  })
})
