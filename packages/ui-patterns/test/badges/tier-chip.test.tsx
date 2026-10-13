import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { isProductionTier, TierChip } from '../../src/badges/tier-chip.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('TierChip', () => {
  it('shows production with the reserved production color, an icon and the word', () => {
    const { container } = render(<TierChip tier="production" />)

    const chip = screen.getByText('Production')
    expect(chip).toHaveAttribute('data-tier', 'production')
    expect(chip.className).toContain('bg-production')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('treats the short name prod as production too', () => {
    render(<TierChip tier="prod" />)

    expect(screen.getByText('Production')).toHaveAttribute('data-tier', 'production')
  })

  it.each([
    ['staging', 'Staging'],
    ['development', 'Development'],
    ['nonprod', 'Non-production'],
  ])('shows %s as a neutral chip without the production color', (tier, label) => {
    render(<TierChip tier={tier} />)

    const chip = screen.getByText(label)
    expect(chip).toHaveAttribute('data-tier', 'nonprod')
    expect(chip.className).not.toContain('production')
    expect(chip.querySelector('svg')).toBeNull()
  })

  it('shows another environment name as it is, neutral', () => {
    render(<TierChip tier="qa-eu" />)

    expect(screen.getByText('qa-eu').closest('[data-tier]')).toHaveAttribute('data-tier', 'nonprod')
  })

  it('does not take a look-alike name for production', () => {
    const { container } = render(<TierChip tier={'production\u{200B}'} />)

    expect(container.querySelector('[data-tier]')).toHaveAttribute('data-tier', 'nonprod')
    expect(screen.getByText('⟨U+200B⟩')).toBeInTheDocument()
  })

  it('does not take a different spelling for production', () => {
    for (const tier of ['Production', 'PRODUCTION', ' production', 'production ', 'prod-eu']) {
      expect(isProductionTier(tier)).toBe(false)
    }
    expect(isProductionTier('production')).toBe(true)
    expect(isProductionTier('prod')).toBe(true)
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <>
        <TierChip tier="production" />
        <TierChip tier="staging" />
      </>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
