import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ClusterCard, type ClusterCardProps } from '../../src/infrastructure/cluster-card.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

function card(extra: Partial<ClusterCardProps> = {}) {
  return (
    <TooltipProvider>
      <ClusterCard
        name="reos-01-main"
        postgresVersion="17.2"
        clusterRole="primary"
        placements={3}
        {...extra}
      />
    </TooltipProvider>
  )
}

describe('ClusterCard', () => {
  it('is an article named by the cluster, with version, role and placements', () => {
    render(card())

    const article = screen.getByRole('article', { name: 'reos-01-main' })
    expect(article).toHaveTextContent('PostgreSQL version')
    expect(article).toHaveTextContent('17.2')
    expect(article).toHaveTextContent('Role')
    expect(article).toHaveTextContent('primary')
    expect(article).toHaveTextContent('Placements')
    expect(article).toHaveTextContent('3')
  })

  it('groups thousands of placements and says unknown for a count that is not a number', () => {
    const { rerender } = render(card({ placements: 1204 }))
    expect(screen.getByRole('article')).toHaveTextContent('1,204')

    rerender(card({ placements: Number.NaN }))
    expect(screen.getByRole('article')).toHaveTextContent('unknown')
  })

  it('shows the state when given, and not otherwise', () => {
    const { rerender } = render(card())
    expect(screen.queryByText('Healthy')).toBeNull()

    rerender(card({ state: 'healthy' }))
    expect(screen.getByText('Healthy')).toBeInTheDocument()
  })

  it('shows values read from the cluster as untrusted text', () => {
    const { container } = render(
      card({
        name: 'main\u{202E}',
        postgresVersion: '17.2<script>x</script>',
        clusterRole: 'pri\u{200D}mary',
      }),
    )

    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+200D⟩')).toBeInTheDocument()
  })

  it('uses the heading level it is given', () => {
    render(card({ headingLevel: 4 }))

    expect(screen.getByRole('heading', { level: 4, name: 'reos-01-main' })).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      card({ state: 'unhealthy', source: 'live', observedAt: '2026-10-13T14:03:30Z' }),
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
