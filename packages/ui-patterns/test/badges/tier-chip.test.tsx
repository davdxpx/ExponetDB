import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { isProductionTier, TierChip } from '../../src/badges/tier-chip.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

function chipOf(element: HTMLElement): HTMLElement | null {
  return element.closest('[data-tier]')
}

describe('TierChip', () => {
  it('shows production with the reserved production color, an icon and the word', () => {
    const { container } = render(<TierChip tier="prod" />)

    const chip = chipOf(screen.getByText('Production'))
    expect(chip).toHaveAttribute('data-tier', 'production')
    expect(chip?.className).toContain('bg-production')
    expect(chip?.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('decides by the tier, never by the environment name', () => {
    render(
      <>
        <TierChip tier="nonprod" name="prod" />
        <TierChip tier="prod" name="live" />
      </>,
    )
    expect(chipOf(screen.getByText('prod'))).toHaveAttribute('data-tier', 'nonprod')
    const live = chipOf(screen.getByText('live'))
    expect(live).toHaveAttribute('data-tier', 'production')
    expect(live).toHaveTextContent('liveProduction')
  })

  it('says production once for an environment named production', () => {
    render(<TierChip tier="prod" name="production" />)
    expect(chipOf(screen.getByText('Production'))?.textContent).toBe('Production')
  })

  it('shows a non-production environment by its name, neutral', () => {
    render(<TierChip tier="nonprod" name="qa-eu" />)

    const chip = chipOf(screen.getByText('qa-eu'))
    expect(chip).toHaveAttribute('data-tier', 'nonprod')
    expect(chip?.className).not.toContain('production')
    expect(chip?.querySelector('svg')).toBeNull()
  })

  it('names the tier when no environment name is given', () => {
    render(<TierChip tier="nonprod" />)
    expect(chipOf(screen.getByText('Non-production'))).toHaveAttribute('data-tier', 'nonprod')
  })

  it('fails closed: a missing, new or misspelled tier is production', () => {
    for (const tier of [
      undefined,
      null,
      '',
      'Nonprod',
      'non-prod',
      'nonprod ',
      'staging',
      'constructor',
    ]) {
      expect(isProductionTier(tier), String(tier)).toBe(true)
    }
    expect(isProductionTier('nonprod')).toBe(false)
    render(<TierChip tier="constructor" name="constructor" />)
    expect(chipOf(screen.getByText('constructor'))).toHaveAttribute('data-tier', 'production')
  })

  it('shows an invisible character in a name by its code point', () => {
    render(<TierChip tier="nonprod" name={'staging\u{200B}'} />)
    expect(screen.getByText('⟨U+200B⟩')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <>
        <TierChip tier="prod" name="live" />
        <TierChip tier="nonprod" name="staging" />
      </>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
