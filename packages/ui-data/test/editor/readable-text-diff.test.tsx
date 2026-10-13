import '@testing-library/jest-dom/vitest'
import type { Readable } from '@exponetdb/ui-patterns'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TextDiffSides } from '../../src/editor/diff-types.ts'
import { ReadableTextDiff } from '../../src/editor/readable-text-diff.tsx'
import { axeViolations } from '../support/axe.ts'
import { installLayoutStubs } from './support.ts'

beforeAll(installLayoutStubs)
afterEach(cleanup)

const sides: TextDiffSides = { before: 'select 1;', after: 'select 2;' }
const observedAt = '2026-10-13T10:00:00.000Z'

function show(readable: Readable<TextDiffSides>, extra: { onRetry?: () => void } = {}) {
  return render(
    <ReadableTextDiff
      label="up.sql: draft against applied"
      what="migration text"
      readable={readable}
      now="2026-10-13T10:05:00.000Z"
      {...extra}
    />,
  )
}

describe('ReadableTextDiff: a failed read is never an empty comparison (C-28)', () => {
  it('shows the failure, the code and a retry, and no diff at all', () => {
    const onRetry = vi.fn()
    const { container } = show(
      {
        state: 'failed',
        error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
      },
      { onRetry },
    )
    expect(screen.getByText('Could not read migration text')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no migration text.')).toBeInTheDocument()
    expect(screen.getByText('TARGET_UNREACHABLE')).toBeInTheDocument()
    expect(container.querySelector('[data-exdb-diff]')).toBeNull()
    expect(container.querySelector('[data-exdb-editor]')).toBeNull()
    expect(container).not.toHaveTextContent('No differences')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows a loading state, not a diff, while the read runs', () => {
    const { container } = show({ state: 'loading' })
    expect(screen.getByRole('status')).toHaveTextContent('Loading migration text')
    expect(container.querySelector('[data-exdb-diff]')).toBeNull()
    expect(container).not.toHaveTextContent('No differences')
  })
})

describe('ReadableTextDiff: a read with a value', () => {
  it('loads the viewer and shows both sides', async () => {
    const { container } = show({ state: 'ready', value: sides, source: 'live', observedAt })
    expect(
      await screen.findByRole('group', { name: 'up.sql: draft against applied' }),
    ).toBeInTheDocument()
    const host = container.querySelector('[data-exdb-editor="diff"]')
    expect(host?.shadowRoot?.querySelectorAll('.cm-editor')).toHaveLength(2)
    expect(await screen.findByText(/1 changed block/)).toBeInTheDocument()
  })

  it('shows a stale read under its banner', async () => {
    show({ state: 'stale', value: sides, source: 'cached', observedAt })
    expect(await screen.findByText('Showing an earlier read of migration text')).toBeInTheDocument()
    expect(
      await screen.findByRole('group', { name: 'up.sql: draft against applied' }),
    ).toBeInTheDocument()
  })

  it('shows a partial read under its banner, with what is missing', async () => {
    show({
      state: 'partial',
      value: sides,
      source: 'live',
      observedAt,
      missing: ['the applied text of the second file'],
    })
    expect(
      await screen.findByRole('group', { name: 'up.sql: draft against applied' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/the applied text of the second file/)).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = show({ state: 'ready', value: sides, source: 'live', observedAt })
    await screen.findByRole('group', { name: 'up.sql: draft against applied' })
    expect(await axeViolations(container)).toEqual([])
  })
})
