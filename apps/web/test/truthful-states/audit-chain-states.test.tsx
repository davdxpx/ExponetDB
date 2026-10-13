import '@testing-library/jest-dom/vitest'
import { act, cleanup, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { auditKeys } from '../../src/features/audit/keys.ts'
import { chain } from '../admin/fixtures.ts'
import { mountApp, problem, T0, World } from '../admin/support.tsx'

/**
 * The audit chain panel reads one verification object (no cursor, no truncation flag): its
 * stale state is proven here, its partial state cannot occur (see the registry exemption).
 */

afterEach(cleanup)

describe('the audit chain panel', () => {
  it('shows an earlier chain verification as earlier, with the way to verify again', async () => {
    const world = new World()
    world.on(
      'GET',
      '/api/v1/audit-events/chain',
      chain({
        anchorCheckpointSeq: 100,
        fromSeq: 100,
        scope: 'from_checkpoint',
        status: 'verified',
        throughSeq: 120,
        verifiedAt: T0,
        verifiedEvents: 21,
      }),
    )
    world.on('GET', '/api/v1/audit-events', { items: [], nextCursor: null })
    const { queryClient } = mountApp('/audit', world)
    await waitFor(() =>
      expect(document.querySelector('#audit-chain [data-chain]')).toHaveAttribute(
        'data-chain',
        'verified',
      ),
    )
    world.on('GET', '/api/v1/audit-events/chain', () =>
      problem(500, 'INTERNAL', 'The server failed.'),
    )
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: auditKeys.chain })
    })
    await waitFor(() =>
      expect(document.querySelector('#audit-chain [data-chain]')?.textContent).toContain(
        'Earlier read, ',
      ),
    )
    expect(
      within(document.querySelector('#audit-chain') as HTMLElement).getByRole('button', {
        name: 'Verify again',
      }),
    ).toBeInTheDocument()
  })
})
