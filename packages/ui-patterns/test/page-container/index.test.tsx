import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { PageContainer } from '../../src/page-container/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('PageContainer', () => {
  it('renders its children in a div and passes attributes and the ref through', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PageContainer ref={ref} data-testid="container" className="extra" id="main-content">
        <p>Page content</p>
      </PageContainer>,
    )

    const container = screen.getByTestId('container')
    expect(container.tagName).toBe('DIV')
    expect(container).toHaveAttribute('id', 'main-content')
    expect(container).toHaveClass('extra')
    expect(ref.current).toBe(container)
    expect(screen.getByText('Page content')).toBeInTheDocument()
  })

  it.each(['small', 'default', 'large', 'full'] as const)('renders the %s size', (size) => {
    render(<PageContainer size={size} data-testid="container" />)

    expect(screen.getByTestId('container')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <PageContainer>
        <p>Page content</p>
      </PageContainer>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
