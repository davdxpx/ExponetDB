import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { BIDI, ChangesWorld, mountChanges, OP, OP2, OP3, operationFor, TAG } from './support.tsx'

afterEach(cleanup)

const label = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`

function listWorld(): ChangesWorld {
  const world = new ChangesWorld()
  world.operationPages.set('', {
    items: [
      operationFor(OP, {
        state: 'verifying',
        applyOutcome: 'applied',
        verificationOutcome: 'pending',
        actor: { identityId: 'idn_01M4S9000000000000000000AD', kind: 'human', via: 'mcp' },
      }),
      operationFor(OP2, {
        state: 'succeeded',
        applyOutcome: 'applied',
        verificationOutcome: 'passed',
        actor: { identityId: 'idn_01M4S9000000000000000000AD', kind: 'human', via: 'web' },
        subject: {
          targetId: 'tgt_01M4S9000000000000000000AE',
          targetPath: 'shop/platform/staging',
          clusterId: null,
          nodeId: null,
          tier: 'nonprod',
        },
      }),
    ],
    nextCursor: null,
  })
  return world
}

async function openList(world: ChangesWorld, path = '/changes/operations') {
  const mounted = mountChanges(path, world)
  await screen.findByRole('heading', { level: 1, name: 'Operations' })
  return mounted
}

const row = (id: string) => document.querySelector(`tr[data-operation="${id}"]`) as HTMLElement

describe('the operations list', () => {
  it('shows the loading state while the list is read', async () => {
    const world = listWorld()
    world.held.add('GET /api/v1/operations?')
    await openList(world)
    await waitFor(() => expect(document.querySelector('[data-state="loading"]')).not.toBeNull())
    expect(screen.queryByText('No operations yet')).toBeNull()
  })

  it('shows a failed read as failed, never as an empty list', async () => {
    const world = listWorld()
    world.failures.set('GET /api/v1/operations?', {
      status: 500,
      code: 'INTERNAL',
      message: 'The operation store is unavailable.',
    })
    await openList(world)
    expect(await screen.findByText('The operation store is unavailable.')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no Operations.')).toBeInTheDocument()
    expect(screen.queryByText('No operations yet')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('says there are no operations only after a successful read', async () => {
    await openList(new ChangesWorld())
    expect(await screen.findByText('No operations yet')).toBeInTheDocument()
  })

  it('says no operation matches a filter, and clears it', async () => {
    const user = userEvent.setup()
    const { router } = await openList(new ChangesWorld(), '/changes/operations?state=failed')
    expect(await screen.findByText('No operation matches')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement)
    await waitFor(() => expect(router.state.location.search).toEqual({}))
  })

  it('shows a stale list with its age when a refresh fails', async () => {
    const world = listWorld()
    const { queryClient } = await openList(world)
    await waitFor(() => expect(row(OP)).not.toBeNull())
    world.failures.set('GET /api/v1/operations?', {
      status: 500,
      code: 'INTERNAL',
      message: 'The operation store is unavailable.',
    })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['operations'] })
    })
    const banner = await waitFor(() => {
      const element = document.querySelector('[data-state="stale"]')
      if (!(element instanceof HTMLElement)) throw new Error('not stale yet')
      return element
    })
    expect(banner.querySelector('time')).not.toBeNull()
    expect(within(banner).getByText('INTERNAL')).toBeInTheDocument()
    expect(row(OP)).not.toBeNull()
  })

  it('lists kind, target with tier, state and apply and verification as separate columns', async () => {
    await openList(listWorld())
    await waitFor(() => expect(row(OP)).not.toBeNull())
    const running = row(OP)
    expect(running).toHaveAttribute('data-tier', 'prod')
    expect(running.querySelector('[data-tier="production"]')).not.toBeNull()
    expect(within(running).getByRole('link', { name: OP })).toHaveAttribute(
      'href',
      `/changes/operations/${OP}`,
    )
    expect(running.querySelector('[data-indicator="apply"]')).toHaveAttribute(
      'data-outcome',
      'applied',
    )
    expect(running.querySelector('[data-indicator="apply"]')?.textContent).toBe(
      'Applied (not verified by itself)',
    )
    expect(running.querySelector('[data-indicator="verification"]')?.textContent).toBe(
      'Not verified yet',
    )
    expect(within(running).getByText('Verifying')).toBeInTheDocument()
    expect(within(running).getByText('MCP (an AI agent)')).toBeInTheDocument()
    const done = row(OP2)
    expect(done.querySelector('[data-tier="production"]')).toBeNull()
    expect(done.querySelector('[data-indicator="verification"]')?.textContent).toBe('Verified')
    expect(within(done).getByRole('link', { name: /shop/ })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging',
    )
  })

  it('sends the filters of the URL and drops anything outside the allowlist', async () => {
    const world = listWorld()
    await openList(
      world,
      '/changes/operations?state=needs_attention&actor=self&kind=migration.apply',
    )
    await waitFor(() => expect(world.gets('/api/v1/operations?')).toHaveLength(1))
    const sent = new URL(world.gets('/api/v1/operations?')[0]?.path ?? '', 'http://x').searchParams
    expect(sent.get('state')).toBe('needs_attention')
    expect(sent.get('actor')).toBe('self')
    expect(sent.get('kind')).toBe('migration.apply')
    cleanup()
    const hostile = listWorld()
    await openList(
      hostile,
      `/changes/operations?state=${encodeURIComponent('<script>')}&kind=${encodeURIComponent(`x${BIDI}`)}&actor=root`,
    )
    await waitFor(() => expect(hostile.gets('/api/v1/operations?')).toHaveLength(1))
    const plain = new URL(hostile.gets('/api/v1/operations?')[0]?.path ?? '', 'http://x')
      .searchParams
    expect(plain.get('state')).toBeNull()
    expect(plain.get('kind')).toBeNull()
    expect(plain.get('actor')).toBe('any')
  })

  it('filters by state and kind through the toolbar, refusing a kind outside the grammar', async () => {
    const world = listWorld()
    const { router } = await openList(world)
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'running' } })
    await waitFor(() => expect(router.state.location.search).toMatchObject({ state: 'running' }))
    await waitFor(() => expect(world.gets('state=running')).toHaveLength(1))
    const kind = screen.getByLabelText('Kind')
    fireEvent.change(kind, { target: { value: 'Drop Table' } })
    expect(screen.getByText(/lower-case words joined by dots/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filter by kind' })).toBeDisabled()
    fireEvent.submit(kind)
    expect(world.gets('kind=')).toHaveLength(0)
    fireEvent.change(kind, { target: { value: 'migration.apply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Filter by kind' }))
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ kind: 'migration.apply' }),
    )
    await waitFor(() => expect(world.gets('kind=migration.apply')).toHaveLength(1))
  })

  it('shows a partial list as partial: it offers the rest and never says all are shown', async () => {
    const world = listWorld()
    const first = world.operationPages.get('')
    world.operationPages.set('', { items: first?.items ?? [], nextCursor: 'c2' })
    await openList(world)
    expect(await screen.findByRole('button', { name: 'Show more operations' })).toBeInTheDocument()
    expect(screen.queryByText(/operations are shown\./)).toBeNull()
    expect(screen.queryByText(/found no operations/i)).toBeNull()
  })

  it('follows the cursor with "Show more operations" and keeps the first page', async () => {
    const user = userEvent.setup()
    const world = listWorld()
    const first = world.operationPages.get('')
    world.operationPages.set('', { items: first?.items ?? [], nextCursor: 'c2' })
    world.operationPages.set('c2', {
      items: [operationFor(OP3, { state: 'failed', applyOutcome: 'not_applied' })],
      nextCursor: null,
    })
    await openList(world)
    await user.click(await screen.findByRole('button', { name: 'Show more operations' }))
    await waitFor(() => expect(row(OP3)).not.toBeNull())
    expect(row(OP)).not.toBeNull()
    expect(world.gets('cursor=c2')).toHaveLength(1)
    expect(screen.getByText('All 3 operations are shown.')).toBeInTheDocument()
  })

  it('renders hostile target paths and kinds as marked text, never as links or markup', async () => {
    const world = new ChangesWorld()
    world.operationPages.set('', {
      items: [
        operationFor(OP, {
          kind: `migration.apply<img src=x onerror=1>` as never,
          subject: {
            targetId: 'tgt_01M4S9000000000000000000AE',
            targetPath: `shop/platform/prod${BIDI}${TAG}<script>x</script>`,
            clusterId: null,
            nodeId: null,
            tier: 'prod',
          },
        }),
      ],
      nextCursor: null,
    })
    await openList(world)
    await waitFor(() => expect(row(OP)).not.toBeNull())
    const hostile = row(OP)
    expect(within(hostile).queryByRole('link', { name: /shop/ })).toBeNull()
    expect(hostile.textContent).toContain(label(0x202e))
    expect(hostile.textContent).toContain(label(0xe0041))
    expect(hostile.textContent).toContain('<script>x</script>')
    expect(document.querySelector('script, img')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    await openList(listWorld())
    await waitFor(() => expect(row(OP)).not.toBeNull())
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the fleet overview links', () => {
  it('open the operations list filtered to running and to those that need attention', async () => {
    const world = listWorld()
    await openList(world, '/changes/operations?state=running')
    await waitFor(() => expect(world.gets('state=running')).toHaveLength(1))
    cleanup()
    const attention = listWorld()
    await openList(attention, '/changes/operations?state=needs_attention')
    await waitFor(() => expect(attention.gets('state=needs_attention')).toHaveLength(1))
  })
})
