import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Avatar, AvatarFallback, AvatarImage } from '../src/avatar.tsx'
import { axeViolations } from './support/axe.ts'

describe('Avatar', () => {
  it('shows the fallback until the image has loaded', async () => {
    render(
      <Avatar>
        <AvatarImage src="/people/ada.png" alt="Ada Lovelace" />
        <AvatarFallback>AL</AvatarFallback>
      </Avatar>,
    )

    // jsdom never loads images, so the fallback stays.
    expect(screen.getByText('AL')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('renders a round avatar with a fallback only', () => {
    const { container } = render(
      <Avatar className="h-6 w-6">
        <AvatarFallback>XL</AvatarFallback>
      </Avatar>,
    )

    expect(container.firstElementChild).toHaveClass('rounded-full', 'h-6', 'w-6')
    expect(container.firstElementChild).not.toHaveClass('h-10')
    expect(screen.getByText('XL')).toHaveClass('rounded-full', 'bg-surface-100')
  })
})
