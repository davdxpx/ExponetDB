import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { NodeCard, type NodeCardProps } from '../../src/infrastructure/node-card.tsx'
import { axeViolations } from '../support/axe.ts'
import { containsInvisible } from '../support/untrusted.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:30Z'

function card(extra: Partial<NodeCardProps> = {}) {
  return (
    <TooltipProvider>
      <NodeCard
        name="reos-01"
        agentVersion="1.2.0"
        lastHeartbeatAt="2026-10-13T14:07:18Z"
        capabilities={['backup.list', 'postgres.status']}
        now={NOW}
        {...extra}
      />
    </TooltipProvider>
  )
}

describe('NodeCard', () => {
  it('is an article named by the node', () => {
    render(card())

    expect(screen.getByRole('article', { name: 'reos-01' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'reos-01' })).toBeInTheDocument()
  })

  it('shows the agent version, the heartbeat age and the capabilities', () => {
    render(card())

    const article = screen.getByRole('article')
    expect(article).toHaveTextContent('Agent version')
    expect(article).toHaveTextContent('1.2.0')
    expect(article).toHaveTextContent('12 s ago (2026-10-13 14:07 UTC)')
    expect(
      within(screen.getByRole('list', { name: 'Capabilities' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['backup.list', 'postgres.status'])
  })

  it('says when no heartbeat was received', () => {
    render(card({ lastHeartbeatAt: null }))

    expect(screen.getByRole('article')).toHaveTextContent('No heartbeat received')
  })

  it('says when the agent reported no capabilities', () => {
    render(card({ capabilities: [] }))

    expect(screen.getByRole('article')).toHaveTextContent('No capabilities reported')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('cuts a long capability list and shows all of it on request', async () => {
    const user = userEvent.setup()
    const capabilities = Array.from({ length: 12 }, (_, n) => `capability.n${n + 1}`)
    render(card({ capabilities, maxCapabilities: 3 }))

    expect(screen.getAllByRole('listitem')).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: 'Show all (12 capabilities)' }))

    expect(screen.getAllByRole('listitem')).toHaveLength(12)
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument()
  })

  it('shows no skew warning when the version is the expected one, or none is expected', () => {
    const { rerender } = render(card({ expectedAgentVersion: '1.2.0' }))
    expect(screen.queryByText(/Version skew/)).toBeNull()

    rerender(card())
    expect(screen.queryByText(/Version skew/)).toBeNull()
  })

  it.each([
    ['1.1.0', '1.2.0', 'older', 'which is older than'],
    ['1.3.0', '1.2.0', 'newer', 'which is newer than'],
    ['nightly', '1.2.0', 'different', 'which differs from'],
  ])(
    'warns of a version skew: agent %s, expected %s',
    (agentVersion, expected, relation, words) => {
      render(card({ agentVersion, expectedAgentVersion: expected }))

      const warning = screen.getByRole('status')
      expect(warning).toHaveAttribute('data-skew', relation)
      expect(warning).toHaveTextContent('Version skew.')
      expect(warning).toHaveTextContent(agentVersion)
      expect(warning).toHaveTextContent(words)
      expect(warning).toHaveTextContent(`the expected ${expected}`)
    },
  )

  it('shows everything the agent reported as untrusted text', () => {
    const { container } = render(
      card({
        name: 'host\u{202E}<b>x</b>',
        agentVersion: '1.2.0\u{200B}',
        capabilities: ['<img src=x onerror=alert(1)>', 'cap\u{202E}ability'],
      }),
    )

    expect(container.querySelector('b, img')).toBeNull()
    expect(screen.getAllByText('⟨U+202E⟩').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('⟨U+200B⟩').length).toBeGreaterThanOrEqual(1)
    expect(containsInvisible(container.textContent ?? '')).toBe(false)
  })

  it('shows the state of the node with its source and age on focus', async () => {
    const user = userEvent.setup()
    render(
      card({ state: 'degraded', source: 'agent_reported', observedAt: '2026-10-13T14:03:30Z' }),
    )

    expect(screen.getByText('Degraded')).toBeInTheDocument()
    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('reported by agent, 4 min ago')
  })

  it('shows no state badge when no state is given', () => {
    render(card())

    expect(screen.queryByText('Healthy')).toBeNull()
    expect(screen.queryByText('Unknown')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      card({
        state: 'healthy',
        source: 'agent_reported',
        observedAt: '2026-10-13T14:03:30Z',
        agentVersion: '1.1.0',
        expectedAgentVersion: '1.2.0',
        capabilities: Array.from({ length: 12 }, (_, n) => `capability.n${n + 1}`),
      }),
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
