import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../src/card.tsx'
import { axeViolations } from './support/axe.ts'

describe('Card', () => {
  it('renders its parts with a heading, a description and without accessibility violations', async () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Backups</CardTitle>
          <CardDescription>Last restore test passed.</CardDescription>
        </CardHeader>
        <CardContent>Retention: 14 days</CardContent>
        <CardFooter>Updated now</CardFooter>
      </Card>,
    )

    expect(screen.getByRole('heading', { name: 'Backups', level: 3 })).toBeInTheDocument()
    expect(screen.getByText('Last restore test passed.').tagName).toBe('P')
    expect(screen.getByTestId('card')).toHaveClass('rounded-lg', 'border', 'bg-surface-100')
    expect(screen.getByText('Retention: 14 days')).toHaveClass('border-b')
    expect(screen.getByText('Updated now')).toHaveClass('flex', 'items-center')
    expect(await axeViolations()).toEqual([])
  })

  it('merges classNames and forwards refs', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Card ref={ref} className="shadow-md">
        content
      </Card>,
    )

    expect(ref.current).toHaveClass('shadow-md')
    expect(ref.current).not.toHaveClass('shadow-xs')
  })
})
