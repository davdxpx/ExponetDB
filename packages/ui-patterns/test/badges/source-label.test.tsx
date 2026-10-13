import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  describeRead,
  SOURCE_DESCRIPTIONS,
  SOURCE_LABELS,
  SourceLabel,
  sourcePhrase,
} from '../../src/badges/source-label.tsx'
import type { ReadSource } from '../../src/readable.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const SOURCES: readonly ReadSource[] = ['live', 'sampled', 'cached', 'agent_reported', 'inferred']
const NOW = '2026-10-13T14:07:30Z'

describe('SourceLabel', () => {
  it.each([
    ['live', 'Live'],
    ['sampled', 'Sampled'],
    ['cached', 'Cached'],
    ['agent_reported', 'Reported by agent'],
    ['inferred', 'Inferred'],
  ] as const)('names %s', (source, label) => {
    render(<SourceLabel source={source} />)

    expect(screen.getByText(label)).toHaveAttribute('data-source', source)
  })

  it('has a label, a phrase and a description for every source', () => {
    for (const source of SOURCES) {
      expect(SOURCE_LABELS[source].length).toBeGreaterThan(0)
      expect(SOURCE_DESCRIPTIONS[source].length).toBeGreaterThan(0)
      expect(sourcePhrase(source)).toBe(SOURCE_LABELS[source].toLowerCase())
    }
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <div>
        {SOURCES.map((source) => (
          <SourceLabel key={source} source={source} />
        ))}
      </div>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('describeRead', () => {
  it('joins the source and the age', () => {
    expect(describeRead('live', '2026-10-13T14:03:30Z', NOW)).toBe('live, 4 min ago')
  })

  it('gives either part alone, or nothing', () => {
    expect(describeRead('cached', undefined, NOW)).toBe('cached')
    expect(describeRead(undefined, '2026-10-13T14:03:30Z', NOW)).toBe('4 min ago')
    expect(describeRead(undefined, undefined, NOW)).toBeUndefined()
  })

  it('says the time is unknown for a time that is not a date', () => {
    expect(describeRead('live', 'garbage', NOW)).toBe('live, time unknown')
    expect(describeRead(undefined, 'garbage', NOW)).toBe('time unknown')
  })
})
