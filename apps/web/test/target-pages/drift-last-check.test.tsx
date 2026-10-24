import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  AGO,
  BIDI,
  driftCheck,
  driftSummary,
  mountOps,
  OpsWorld,
  project,
  TARGET,
  ulid,
  withDefaults,
} from './support.tsx'

/**
 * The last drift check on the drift page: read on mount from `GET /targets/{target}/drift-checks`
 * (the Control Store's record of the checks, scheduled and on demand), shown with its time, who ran
 * it, its status, counts and fingerprints. The read states are named truthfully: a failed read is
 * never "no check recorded", an old read is stale with its age, and a check that compared nothing
 * shows no counts.
 */

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PAGE = `/t/${TARGET}/drift`
const CHECKS = /\/drift-checks\?/

function world(items: unknown[] = [driftSummary(1)], nextCursor: string | null = null): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET)
  withDefaults(w)
  w.on('GET', CHECKS, { items, nextCursor })
  return w
}

async function lastCheck(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector('[data-slot="last-check"]')
    if (el === null) throw new Error('no last check yet')
    return el as HTMLElement
  })
}

describe('the last drift check', () => {
  it('reads the checks on mount and shows the last one: when, by the schedule, status, counts, fingerprints', async () => {
    const w = world([
      driftSummary(1, { finishedAt: AGO(5 * 60_000 + 20_000) }),
      driftSummary(2, { status: 'clean' }),
    ])
    mountOps(PAGE, w)
    const block = await lastCheck()
    await waitFor(() => expect(block.querySelector('[data-drift-last]')).not.toBeNull())
    expect(block.textContent).toContain('Last checked')
    expect(block.textContent).toContain('5 min ago')
    expect(block.textContent).toContain('The schedule')
    const latest = block.querySelector('[data-drift-last]') as HTMLElement
    expect(latest).toHaveAttribute('data-drift-last', `smp_${ulid(1)}`)
    expect(latest.textContent).toContain('Drifted')
    expect(latest.textContent).toContain('Drifted: 2')
    expect(latest.textContent).toContain('Unmanaged: 1')
    expect(latest.textContent).toContain('Matched: 40')
    expect(latest.textContent).toContain(`fp1:17:${'a'.repeat(64)}`)
    expect(latest.textContent).toContain(`fp1:17:${'b'.repeat(64)}`)
    // The page says the findings of a check are not stored with it.
    expect(block.textContent).toContain('Findings are not stored per check')
    // One read of the history: the last ten, newest first.
    const [call] = w.callsTo('GET', CHECKS)
    expect(call?.url).toContain('limit=10')
    expect(call?.url).toContain(`/targets/${encodeURIComponent(TARGET)}/drift-checks`)
    // No source label of a database read: this is the record of the checks.
    expect(within(block).queryByText('Live')).toBeNull()
  })

  it('names a check run by an identity as such, with the id as text', async () => {
    const id = `idn_${ulid(5)}`
    mountOps(PAGE, world([driftSummary(1, { requestedBy: { kind: 'identity', identityId: id } })]))
    const block = await lastCheck()
    await waitFor(() => expect(block.textContent).toContain('A person or service account'))
    expect(block.textContent).toContain(id)
  })

  it('shows a failed read as failed with its code, never as no check recorded', async () => {
    const w = world()
    w.fail('GET', CHECKS, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    const block = await lastCheck()
    await waitFor(() => expect(block.textContent).toContain('Could not read drift checks'))
    expect(block.textContent).toContain('INTERNAL_ERROR')
    expect(block.textContent).not.toContain('No drift check is recorded')
    expect(block.querySelector('[data-drift-last]')).toBeNull()
  })

  it('names the permission that was refused instead of saying there is no check', async () => {
    const w = world()
    w.fail('GET', CHECKS, 403, 'PERMISSION_DENIED')
    mountOps(PAGE, w)
    const block = await lastCheck()
    await waitFor(() => expect(within(block).getByText('diagnostics.read')).toBeInTheDocument())
    expect(block.textContent).not.toContain('No drift check is recorded')
  })

  it('says no check is recorded only after a successful empty read', async () => {
    mountOps(PAGE, world([]))
    const block = await lastCheck()
    await waitFor(() =>
      expect(block.textContent).toContain(
        'No drift check is recorded for this target. The read succeeded and found none',
      ),
    )
    expect(block.querySelector('[data-drift-last]')).toBeNull()
  })

  it('shows an old read as stale with its age and a refresh, keeping the last check', async () => {
    const w = world()
    const { queryClient } = mountOps(PAGE, w)
    const block = await lastCheck()
    await waitFor(() => expect(block.querySelector('[data-drift-last]')).not.toBeNull())
    w.fail('GET', CHECKS, 400, 'VALIDATION_FAILED')
    await act(async () => {
      await queryClient.refetchQueries()
    })
    await waitFor(() =>
      expect(
        within(block).getByText(/Showing an earlier read of drift checks/i),
      ).toBeInTheDocument(),
    )
    expect(within(block).getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(block.querySelector('[data-drift-last]')).not.toBeNull()
  })

  it('shows no counts for a check that compared nothing, and says it is not a clean result', async () => {
    const zeros = { drifted: 0, matched: 0, unmanaged: 0, opened: 0, updated: 0, resolved: 0 }
    const cases: [string, string][] = [
      ['failed', 'The check failed.'],
      ['no_baseline', 'There is no expected schema to compare with yet'],
      ['not_comparable', 'come from different fingerprint or PostgreSQL versions'],
      ['incomplete', 'Part of the schema could not be read.'],
    ]
    for (const [status, note] of cases) {
      const w = world([
        driftSummary(1, {
          status,
          counts: zeros,
          errorCode: status === 'failed' ? 'TARGET_UNAVAILABLE' : null,
          currentFingerprint: null,
        }),
      ])
      mountOps(PAGE, w)
      const block = await lastCheck()
      await waitFor(() => expect(block.textContent).toContain(note))
      expect(block.textContent).toContain('Nothing was compared, so this is not a clean result')
      // The counts row is left out: a row of zeros would read as a clean result.
      expect(within(block).queryByText('Findings')).toBeNull()
      expect(block.textContent).not.toContain('Drifted: 0')
      expect(block.textContent).not.toContain('Matched: 0')
      expect(block.textContent).toContain('Not recorded')
      if (status === 'failed') expect(block.textContent).toContain('TARGET_UNAVAILABLE')
      cleanup()
    }
  })

  it('shows a clean check with its counts, zeros included, because it compared', async () => {
    mountOps(
      PAGE,
      world([
        driftSummary(1, {
          status: 'clean',
          counts: { drifted: 0, matched: 42, unmanaged: 0, opened: 0, updated: 0, resolved: 0 },
        }),
      ]),
    )
    const block = await lastCheck()
    await waitFor(() => expect(block.textContent).toContain('Clean'))
    expect(block.textContent).toContain('Drifted: 0')
    expect(block.textContent).toContain('Matched: 42')
    expect(block.textContent).not.toContain('Not shown')
  })

  it('shows a status this page does not know as text, with no counts and no claim', async () => {
    mountOps(
      PAGE,
      world([driftSummary(1, { status: `new_status${BIDI}x`, requestedBy: { kind: 'robot' } })]),
    )
    const block = await lastCheck()
    await waitFor(() => expect(block.textContent).toContain('new_status'))
    expect(block.textContent).toContain('⟨U+202E⟩')
    expect(block.textContent).not.toContain(BIDI)
    expect(block.textContent).toContain('Not recognized')
    expect(block.textContent).toContain(
      'This page does not know this status, so it shows no counts',
    )
    expect(within(block).queryByText('Findings')).toBeNull()
  })

  it('says when a check ran against another generation of the target', async () => {
    mountOps(PAGE, world([driftSummary(1, { generation: 3 })]))
    const block = await lastCheck()
    await waitFor(() =>
      expect(block.textContent).toContain(
        'This check ran against generation 3, not the current generation 1',
      ),
    )
  })

  it('lists the last checks in a fold, newest first, and says older ones exist', async () => {
    const items = Array.from({ length: 10 }, (_, n) =>
      driftSummary(n + 1, { status: n % 2 === 0 ? 'drifted' : 'clean' }),
    )
    mountOps(PAGE, world(items, 'older'))
    const block = await lastCheck()
    const fold = await waitFor(() => {
      const el = block.querySelector('[data-slot="check-history"]')
      if (el === null) throw new Error('no history yet')
      return el as HTMLElement
    })
    expect(fold).not.toHaveAttribute('open')
    expect(within(fold).getByText('The last 10 checks')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(within(fold).getByText('The last 10 checks'))
    const table = within(fold).getByRole('table', {
      name: 'Recent drift checks, newest first',
    })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(10)
    expect(rows[0]).toHaveAttribute('data-check', `smp_${ulid(1)}`)
    expect(rows[0]?.textContent).toContain('2 drifted, 1 unmanaged, 40 matched')
    expect(
      within(fold).getByText('Older checks exist. Only the last 10 are listed.'),
    ).toBeInTheDocument()
  })

  it('has no history fold for one check', async () => {
    mountOps(PAGE, world())
    const block = await lastCheck()
    await waitFor(() => expect(block.querySelector('[data-drift-last]')).not.toBeNull())
    expect(block.querySelector('[data-slot="check-history"]')).toBeNull()
  })

  it('reads the record again after a check is run, and shows the new one', async () => {
    const w = world([driftSummary(2)])
    let ran = false
    w.on('POST', /\/drift-checks$/, () => {
      ran = true
      return { status: 201, body: driftCheck({ id: `smp_${ulid(9)}` }) }
    })
    w.on('GET', CHECKS, () => ({
      status: 200,
      body: {
        items: ran
          ? [
              driftSummary(9, {
                requestedBy: { kind: 'identity', identityId: `idn_${ulid(1)}` },
                finishedAt: new Date().toISOString(),
              }),
              driftSummary(2),
            ]
          : [driftSummary(2)],
        nextCursor: null,
      },
    }))
    mountOps(PAGE, w)
    const block = await lastCheck()
    await waitFor(() =>
      expect(block.querySelector('[data-drift-last]')).toHaveAttribute(
        'data-drift-last',
        `smp_${ulid(2)}`,
      ),
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Run drift check' }))
    await waitFor(() =>
      expect(block.querySelector('[data-drift-last]')).toHaveAttribute(
        'data-drift-last',
        `smp_${ulid(9)}`,
      ),
    )
    expect(block.textContent).toContain('A person or service account')
    expect(w.callsTo('GET', CHECKS).length).toBeGreaterThanOrEqual(2)
  })

  it('has no accessibility violations with the history open', async () => {
    const items = [driftSummary(1), driftSummary(2, { status: 'failed', errorCode: 'INTERNAL' })]
    mountOps(PAGE, world(items))
    const block = await lastCheck()
    await waitFor(() => expect(block.querySelector('[data-slot="check-history"]')).not.toBeNull())
    const user = userEvent.setup()
    await user.click(within(block).getByText('The last 2 checks'))
    expect(await axeViolations(document.body)).toEqual([])
  })
})
