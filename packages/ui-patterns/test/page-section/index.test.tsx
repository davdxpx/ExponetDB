import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PageSection,
  PageSectionAside,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from '../../src/page-section/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

function Section({ orientation }: { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <PageSection orientation={orientation} data-testid="section">
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>Approvals</PageSectionTitle>
          <PageSectionDescription>Who must approve plans for this target.</PageSectionDescription>
        </PageSectionSummary>
        <PageSectionAside>
          <button type="button">Add rule</button>
        </PageSectionAside>
      </PageSectionMeta>
      <PageSectionContent>
        <p>Content</p>
      </PageSectionContent>
    </PageSection>
  )
}

describe('PageSection', () => {
  it('names the section with an h2', () => {
    render(<Section />)

    expect(screen.getByRole('heading', { level: 2, name: 'Approvals' })).toBeInTheDocument()
  })

  it('shows description, actions and content', () => {
    render(<Section />)

    expect(screen.getByText('Who must approve plans for this target.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeVisible()
    expect(screen.getByText('Content')).toBeVisible()
  })

  it('is vertical by default and can be horizontal', () => {
    const { rerender } = render(<Section />)
    expect(screen.getByTestId('section')).toHaveAttribute('data-orientation', 'vertical')

    rerender(<Section orientation="horizontal" />)
    expect(screen.getByTestId('section')).toHaveAttribute('data-orientation', 'horizontal')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Section />)

    expect(await axeViolations(container)).toEqual([])
  })
})
