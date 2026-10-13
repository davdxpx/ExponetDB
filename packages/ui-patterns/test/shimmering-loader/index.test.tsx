import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  GenericSelectionSkeletonLoader,
  GenericSkeletonLoader,
  GenericTableLoader,
  ShimmeringLoader,
} from '../../src/shimmering-loader/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('ShimmeringLoader', () => {
  it('is a block hidden from assistive technology', () => {
    const { container } = render(<ShimmeringLoader className="h-4 w-20" />)

    const block = container.firstElementChild
    expect(block).toHaveAttribute('aria-hidden', 'true')
    expect(block).toHaveClass('shimmering-loader', 'h-4', 'w-20')
  })

  it('staggers the highlight by index', () => {
    const { container } = render(<ShimmeringLoader delayIndex={3} animationDelay={100} />)

    expect(container.firstElementChild).toHaveStyle({ animationDelay: '300ms' })
  })

  it('forwards the ref', () => {
    let element: HTMLDivElement | null = null
    render(
      <ShimmeringLoader
        ref={(node) => {
          element = node
        }}
      />,
    )

    expect(element).toBeInstanceOf(HTMLDivElement)
  })
})

describe('the stylesheet of the shimmer', () => {
  const css = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'src',
      'shimmering-loader',
      'index.css',
    ),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')

  it('stops the movement under prefers-reduced-motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('animation: none')
  })

  it('follows the single theme mechanism, never a .dark class', () => {
    expect(css).toMatch(/\[data-theme\*=['"]dark['"]\] \.shimmering-loader/)
    expect(css).not.toMatch(/\.dark\b/)
  })

  it('uses token variables only', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/)
  })
})

describe('GenericSkeletonLoader', () => {
  it('announces loading as a status', () => {
    render(<GenericSkeletonLoader />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading')
  })

  it('announces the label given', () => {
    render(<GenericSkeletonLoader label="Loading plans" />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading plans')
  })
})

describe('GenericSelectionSkeletonLoader', () => {
  it.each(['command', 'multi-select', 'select'] as const)(
    'hides the %s rows from assistive technology',
    (variant) => {
      const { container } = render(<GenericSelectionSkeletonLoader variant={variant} />)

      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    },
  )

  it('has no row indicators in the command variant', () => {
    const { container } = render(<GenericSelectionSkeletonLoader variant="command" />)

    expect(container.querySelectorAll('.shimmering-loader')).toHaveLength(3)
  })
})

describe('GenericTableLoader', () => {
  it('is a busy table named by its label with the headers given and placeholder rows', () => {
    render(<GenericTableLoader headers={['Name', 'State']} numRows={4} label="Loading targets" />)

    const table = screen.getByRole('table', { name: 'Loading targets' })
    expect(table).toHaveAttribute('aria-busy', 'true')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'State'])
    expect(within(table).getAllByRole('row')).toHaveLength(5)
  })

  it('spans the placeholder over all columns', () => {
    render(<GenericTableLoader headers={['Name', 'State', null]} numRows={1} />)

    expect(screen.getAllByRole('cell')[0]).toHaveAttribute('colspan', '3')
  })

  it('is valid without headers', () => {
    render(<GenericTableLoader />)

    expect(screen.getAllByRole('row')).toHaveLength(4)
    expect(screen.getAllByRole('cell')[0]).toHaveAttribute('colspan', '1')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <>
        <GenericSkeletonLoader />
        <GenericTableLoader headers={['Name', 'State']} />
      </>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
