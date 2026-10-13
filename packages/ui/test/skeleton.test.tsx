import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Skeleton } from '../src/skeleton.tsx'
import { axeViolations } from './support/axe.ts'

describe('Skeleton', () => {
  it('pulses, respects reduced motion and is hidden from assistive technology', async () => {
    const { container } = render(<Skeleton className="h-4 w-32" />)

    const skeleton = container.firstElementChild
    expect(skeleton).toHaveClass('animate-pulse', 'motion-reduce:animate-none', 'h-4', 'w-32')
    expect(skeleton).toHaveAttribute('aria-hidden', 'true')
    expect(await axeViolations()).toEqual([])
  })

  it('lets a caller opt back into the accessibility tree', () => {
    const { container } = render(
      <Skeleton aria-hidden={false} role="status" aria-label="Loading" />,
    )

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'false')
    expect(container.firstElementChild).toHaveAttribute('role', 'status')
  })
})
