import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Readable } from '../../src/readable.ts'
import { ReadableView } from '../../src/states/readable-view.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:30Z'
const OBSERVED = '2026-10-13T14:03:00Z'
const EMPTY_CONTENT = 'EMPTY-CONTENT-MARKER'
const emptyList = {
  isEmpty: (rows: readonly string[]) => rows.length === 0,
  content: <p>{EMPTY_CONTENT}</p>,
}

function renderView(
  readable: Readable<readonly string[]>,
  extra: Partial<React.ComponentProps<typeof ReadableView<readonly string[]>>> = {},
) {
  const ready = vi.fn((rows: readonly string[]) => (
    <ul>
      {rows.map((row) => (
        <li key={row}>{row}</li>
      ))}
    </ul>
  ))
  const view = render(
    <ReadableView
      readable={readable}
      what="backup inventory"
      ready={ready}
      empty={emptyList}
      now={NOW}
      {...extra}
    />,
  )
  return { ...view, ready }
}

describe('ReadableView: loading', () => {
  it('announces "Loading X" and renders neither the value nor the empty content', () => {
    const { ready } = renderView({ state: 'loading' })

    expect(screen.getByRole('status')).toHaveTextContent('Loading backup inventory')
    expect(screen.queryByText(EMPTY_CONTENT)).toBeNull()
    expect(ready).not.toHaveBeenCalled()
  })

  it('renders the skeleton the caller shaped', () => {
    renderView({ state: 'loading' }, { loading: <div data-testid="my-skeleton" /> })

    expect(within(screen.getByRole('status')).getByTestId('my-skeleton')).toBeInTheDocument()
  })
})

describe('ReadableView: failed read', () => {
  const failed: Readable<readonly string[]> = {
    state: 'failed',
    error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer within 5 seconds.' },
  }

  it('says what could not be read, why, the stable code, and that it does not mean there is none', () => {
    renderView(failed)

    const alert = screen.getByRole('alert')
    expect(
      within(alert).getByRole('heading', { name: 'Could not read backup inventory' }),
    ).toBeInTheDocument()
    expect(alert).toHaveTextContent('The target did not answer within 5 seconds.')
    expect(alert).toHaveTextContent('TARGET_UNREACHABLE')
    expect(alert).toHaveTextContent('This does not mean there is no backup inventory.')
  })

  it('never shows the empty content, whatever isEmpty answers', () => {
    const isEmpty = vi.fn(() => true)
    const { ready } = renderView(failed, {
      empty: { isEmpty, content: <p>{EMPTY_CONTENT}</p> },
    })

    expect(screen.queryByText(EMPTY_CONTENT)).toBeNull()
    expect(screen.queryByText('Nothing to show')).toBeNull()
    expect(document.querySelector('[data-slot="empty-state"]')).toBeNull()
    expect(isEmpty).not.toHaveBeenCalled()
    expect(ready).not.toHaveBeenCalled()
  })

  it('never shows the default empty state either', () => {
    render(
      <ReadableView
        readable={failed}
        what="targets"
        ready={() => <p>rows</p>}
        empty={{ isEmpty: () => true }}
      />,
    )

    expect(screen.queryByText('Nothing to show')).toBeNull()
    expect(screen.queryByText(/found no targets/)).toBeNull()
  })

  it('offers a retry that reads again, and shows it is busy', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const { rerender } = renderView(failed, { onRetry })

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()

    rerender(
      <ReadableView
        readable={failed}
        what="backup inventory"
        ready={() => null}
        onRetry={onRetry}
        busy
      />,
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
  })

  it('shows no retry button without a retry handler', () => {
    renderView(failed)

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says so when the failure carries no reason', () => {
    renderView({ state: 'failed', error: { code: 'UNKNOWN', message: '   ' } })

    expect(screen.getByRole('alert')).toHaveTextContent('No reason was reported.')
  })

  it('renders a state it does not know as a failed read, never as empty', () => {
    const malformed = { state: 'bogus' } as unknown as Readable<readonly string[]>
    const { ready } = renderView(malformed)

    expect(screen.getByRole('alert')).toHaveTextContent('Could not read backup inventory')
    expect(screen.getByRole('alert')).toHaveTextContent('UNKNOWN')
    expect(screen.queryByText(EMPTY_CONTENT)).toBeNull()
    expect(ready).not.toHaveBeenCalled()
  })

  it('has no accessibility violations', async () => {
    const { container } = renderView(failed, { onRetry: () => {} })

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('ReadableView: ready', () => {
  it('renders the value with where it comes from', () => {
    const { ready } = renderView({
      state: 'ready',
      value: ['b1', 'b2'],
      source: 'live',
      observedAt: OBSERVED,
    })

    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['b1', 'b2'])
    expect(ready).toHaveBeenCalledWith(['b1', 'b2'], {
      state: 'ready',
      source: 'live',
      observedAt: OBSERVED,
    })
  })

  it('renders the empty content only after a successful read that found nothing', () => {
    const { ready } = renderView({
      state: 'ready',
      value: [],
      source: 'live',
      observedAt: OBSERVED,
    })

    expect(screen.getByText(EMPTY_CONTENT)).toBeInTheDocument()
    expect(ready).not.toHaveBeenCalled()
  })

  it('renders a default empty state that says the read succeeded', () => {
    render(
      <ReadableView
        readable={{ state: 'ready', value: [] as string[], source: 'live', observedAt: OBSERVED }}
        what="targets"
        ready={() => <p>rows</p>}
        empty={{ isEmpty: (rows) => rows.length === 0 }}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Nothing to show' })).toBeInTheDocument()
    expect(screen.getByText('The read succeeded and found no targets.')).toBeInTheDocument()
  })

  it('renders the value when no empty rule is given', () => {
    render(
      <ReadableView
        readable={{ state: 'ready', value: [] as string[], source: 'live', observedAt: OBSERVED }}
        what="targets"
        ready={(rows) => <p>{`${rows.length} rows`}</p>}
      />,
    )

    expect(screen.getByText('0 rows')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = renderView({
      state: 'ready',
      value: ['b1'],
      source: 'live',
      observedAt: OBSERVED,
    })

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('ReadableView: stale', () => {
  const stale: Readable<readonly string[]> = {
    state: 'stale',
    value: ['b1'],
    source: 'cached',
    observedAt: OBSERVED,
  }

  it('shows the value under a banner with source and age', () => {
    renderView(stale)

    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Showing an earlier read of backup inventory')
    expect(banner).toHaveTextContent('Source: cached')
    expect(banner).toHaveTextContent('4 min ago (2026-10-13 14:03 UTC)')
    expect(screen.getByText('b1')).toBeInTheDocument()
    expect(banner.querySelector('time')).toHaveAttribute('datetime', '2026-10-13T14:03:00.000Z')
  })

  it('offers a refresh that reads again', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    renderView(stale, { onRefresh })

    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('shows no refresh button without a handler', () => {
    renderView(stale)

    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  it('names the reason a refresh failed, with its code', () => {
    renderView({
      ...stale,
      error: { code: 'TARGET_UNREACHABLE', message: 'The target did not answer.' },
    } as Readable<readonly string[]>)

    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Could not refresh: The target did not answer.')
    expect(banner).toHaveTextContent('TARGET_UNREACHABLE')
  })

  it('shows a stale value that is empty as empty, under the banner', () => {
    renderView({ ...stale, value: [] } as Readable<readonly string[]>)

    expect(screen.getByText(EMPTY_CONTENT)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Showing an earlier read')
  })

  it('has no accessibility violations', async () => {
    const { container } = renderView(stale, { onRefresh: () => {} })

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('ReadableView: partial', () => {
  const partial: Readable<readonly string[]> = {
    state: 'partial',
    value: ['b1'],
    source: 'agent_reported',
    observedAt: OBSERVED,
    missing: ['Node reos-01 did not answer.', 'Backups of the staging cluster are not listed.'],
  }

  it('shows the value under a banner saying what is missing', () => {
    renderView(partial)

    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Showing part of backup inventory')
    expect(banner).toHaveTextContent('Source: reported by agent')
    expect(
      within(banner)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Node reos-01 did not answer.', 'Backups of the staging cluster are not listed.'])
    expect(screen.getByText('b1')).toBeInTheDocument()
  })

  it('never shows the empty content: what is missing may be what was asked for', () => {
    const { ready } = renderView({ ...partial, value: [] } as Readable<readonly string[]>)

    expect(screen.queryByText(EMPTY_CONTENT)).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Showing part of backup inventory')
    expect(ready).toHaveBeenCalledWith([], {
      state: 'partial',
      source: 'agent_reported',
      observedAt: OBSERVED,
    })
  })

  it('has no accessibility violations', async () => {
    const { container } = renderView(partial)

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('ReadableView: types', () => {
  it('does not accept data without a state', () => {
    // @ts-expect-error a bare array is not a Readable: no API takes data without saying how it was read
    const element = <ReadableView readable={['b1']} what="x" ready={() => null} />
    expect(element).toBeDefined()
  })

  it('hands the empty rule the value only, never the read', () => {
    const element = (
      <ReadableView<readonly string[]>
        readable={{ state: 'loading' }}
        what="x"
        ready={() => null}
        empty={{
          // @ts-expect-error isEmpty receives the value, so it cannot be fed a failed read
          isEmpty: (read: Readable<readonly string[]>) => read.state === 'failed',
        }}
      />
    )
    expect(element).toBeDefined()
  })
})
