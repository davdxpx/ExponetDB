import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { localInputToUtc, toLocalInput } from '../../src/features/audit/time-range.ts'
import type { ResponseOf } from '../../src/lib/api/client.ts'
import { chain, event } from '../admin/fixtures.ts'
import { BIDI, expectInert, HOSTILE, mountApp, problem, T0, World } from '../admin/support.tsx'

afterEach(cleanup)

type Target = ResponseOf<'listTargets'>['items'][number]

const PROD = 'tgt_01JZ0000000000000000000011'
const STAGING = 'tgt_01JZ0000000000000000000012'

function target(over: Partial<Target> = {}): Target {
  return {
    environmentId: 'env_01JZ0000000000000000000001',
    generation: 1,
    health: null,
    id: PROD,
    path: 'shop/app/production',
    productId: 'prd_01JZ0000000000000000000001',
    projectId: 'prj_01JZ0000000000000000000001',
    state: 'active',
    tier: 'prod',
    ...over,
  }
}

const VERIFIED = chain({
  anchorCheckpointSeq: 100,
  fromSeq: 100,
  scope: 'from_checkpoint',
  status: 'verified',
  throughSeq: 120,
  verifiedAt: T0,
  verifiedEvents: 21,
})

function auditWorld(targets: unknown = { items: [target()], nextCursor: null }): World {
  const world = new World()
  world.on('GET', '/api/v1/audit-events/chain', VERIFIED)
  world.on('GET', '/api/v1/audit-events', { items: [event()], nextCursor: null })
  world.on('GET', '/api/v1/targets', targets as object)
  return world
}

async function filters(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.getElementById('audit-filters')
    if (found === null) throw new Error('no filters')
    return found
  })
}

/** The UTC text of a local date and time, as the page sends it. */
const utcOf = (local: string): string => new Date(local).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('the time of the audit search', () => {
  it('converts a date and time in the viewer’s zone to UTC and says what is sent', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    const { router } = mountApp('/audit', world)
    const form = await filters()
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-10-13T09:15' } })
    fireEvent.change(within(form).getByLabelText('Until'), {
      target: { value: '2026-10-13T17:45' },
    })
    expect(
      within(form).getByText(`Searched as ${utcOf('2026-10-13T09:15')} (UTC).`),
    ).toBeInTheDocument()
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    const from = utcOf('2026-10-13T09:15')
    const to = utcOf('2026-10-13T17:45')
    await waitFor(() => expect(router.state.location.search).toEqual({ from, to }))
    await waitFor(() => {
      const last = world.reads('/api/v1/audit-events').at(-1)?.search
      expect(last?.get('from')).toBe(from)
      expect(last?.get('to')).toBe(to)
    })
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/)
  })

  it('fills the start from a quick range, leaves the end open and sends nothing until searched', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    const { router } = mountApp('/audit', world)
    const form = await filters()
    fireEvent.change(within(form).getByLabelText('Until'), {
      target: { value: '2026-10-13T17:45' },
    })
    const before = Date.now()
    await user.click(within(form).getByRole('button', { name: 'Last 24 hours' }))
    const after = Date.now()
    expect(within(form).getByLabelText('Until')).toHaveValue('')
    expect(within(form).getByLabelText('From')).not.toHaveValue('')
    // A quick range only fills the field: the address and the read are unchanged.
    expect(router.state.location.searchStr).toBe('')

    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    await waitFor(() => expect(router.state.location.search).toHaveProperty('from'))
    const sent = (router.state.location.search as { from?: string }).from ?? ''
    expect(sent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/)
    const day = 24 * 60 * 60_000
    expect(Date.parse(sent)).toBeGreaterThanOrEqual(Math.floor((before - day) / 60_000) * 60_000)
    expect(Date.parse(sent)).toBeLessThanOrEqual(after - day)
    expect(router.state.location.search).not.toHaveProperty('to')
  })

  it('offers the quick ranges the order names, as buttons that do not submit the form', async () => {
    const world = auditWorld()
    mountApp('/audit', world)
    const form = await filters()
    const group = within(form).getByRole('group', { name: 'Quick ranges' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Last hour', 'Last 6 hours', 'Last 24 hours', 'Last 7 days', 'Last 30 days'])
    for (const button of within(group).getAllByRole('button')) {
      expect(button).toHaveAttribute('type', 'button')
    }
  })

  it('sends a time from the address exactly as it came until the person changes it', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    const { router } = mountApp('/audit?from=2026-10-13T09:00:07Z', world)
    const form = await filters()
    // The field shows the minute in the viewer's zone; the seconds of the link are not lost.
    expect(within(form).getByLabelText('From')).toHaveValue(
      toLocalInput(new Date('2026-10-13T09:00:07Z')),
    )
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    await waitFor(() =>
      expect(router.state.location.search).toHaveProperty('from', '2026-10-13T09:00:07Z'),
    )

    fireEvent.change(within(await filters()).getByLabelText('From'), {
      target: { value: '2026-10-13T10:00' },
    })
    await user.click(within(await filters()).getByRole('button', { name: 'Search audit events' }))
    await waitFor(() =>
      expect(router.state.location.search).toHaveProperty('from', utcOf('2026-10-13T10:00')),
    )
  })

  it('refuses an end that is not after the start and keeps the address as it was', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    const { router } = mountApp('/audit', world)
    const form = await filters()
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-10-13T12:00' } })
    fireEvent.change(within(form).getByLabelText('Until'), {
      target: { value: '2026-10-13T11:00' },
    })
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    expect(await within(form).findByText('The end must be after the start.')).toBeInTheDocument()
    expect(router.state.location.searchStr).toBe('')
  })

  it('refuses a date that the calendar does not have instead of moving it to another day', () => {
    expect(localInputToUtc('2026-02-31T10:00')).toBeUndefined()
    expect(localInputToUtc('2026-13-01T10:00')).toBeUndefined()
    expect(localInputToUtc('2026-10-13 09:00')).toBeUndefined()
    expect(localInputToUtc('yesterday')).toBeUndefined()
    expect(localInputToUtc('')).toBeUndefined()
    expect(localInputToUtc('2026-10-13T09:15')).toBe(utcOf('2026-10-13T09:15'))
    expect(localInputToUtc('2026-10-13T09:15')).toMatch(/Z$/)
  })
})

describe('the target of the audit search', () => {
  it('picks a target by its path and sends its ID, shown beside the path as text', async () => {
    const user = userEvent.setup()
    const world = auditWorld({
      items: [target(), target({ id: STAGING, path: 'shop/app/staging', tier: 'nonprod' })],
      nextCursor: null,
    })
    const { router, container } = mountApp('/audit', world)
    const form = await filters()
    const choice = await within(form).findByRole('option', {
      name: 'shop/app/production (Production)',
    })
    expect(choice).toBeInTheDocument()
    expect(
      within(form).getByRole('option', { name: 'shop/app/staging (Non-production)' }),
    ).toBeInTheDocument()
    expect(form.querySelector('[data-chosen-target]')).toBeNull()
    await user.selectOptions(within(form).getByLabelText('Target'), PROD)
    expect(within(form).getByLabelText('Target ID')).toHaveValue(PROD)
    // The chosen target's path and tier are shown beside the choice, as text.
    const chosen = form.querySelector('[data-chosen-target]')
    expect(chosen).toHaveTextContent('shop/app/production')
    expect(chosen?.querySelector('[data-tier="production"]')).not.toBeNull()
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    await waitFor(() => expect(router.state.location.href).toBe(`/audit?target=${PROD}`))
    await waitFor(() =>
      expect(world.reads('/api/v1/audit-events').at(-1)?.search.get('target')).toBe(PROD),
    )
    // The chosen target stays chosen after the search.
    expect(within(await filters()).getByLabelText('Target')).toHaveValue(PROD)
    expect(await axeViolations(container)).toEqual([])
  })

  it('still accepts a typed ID, also one the list does not hold, and refuses a malformed one', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    const { router } = mountApp('/audit', world)
    const form = await filters()
    await within(form).findByRole('option', { name: 'shop/app/production (Production)' })
    fireEvent.change(within(form).getByLabelText('Target ID'), { target: { value: 'tgt_nope' } })
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    expect(await within(form).findByText(/Expected: A tgt_ ID/)).toBeInTheDocument()
    expect(router.state.location.searchStr).toBe('')

    const unlisted = 'tgt_01JZ0000000000000000000099'
    fireEvent.change(within(form).getByLabelText('Target ID'), { target: { value: unlisted } })
    // An ID that is not in the list shows no choice, not a wrong one.
    expect(within(form).getByLabelText('Target')).toHaveValue('')
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    await waitFor(() => expect(router.state.location.href).toBe(`/audit?target=${unlisted}`))
  })

  it('shows a hostile target path as plain text with its hidden characters named', async () => {
    const world = auditWorld({
      items: [target({ path: `shop/${BIDI}${HOSTILE}/production` })],
      nextCursor: null,
    })
    const { container } = mountApp('/audit', world)
    const form = await filters()
    const option = await waitFor(() => {
      const found = form.querySelector('option[value^="tgt_"]')
      if (found === null) throw new Error('no option yet')
      return found
    })
    expect(option.textContent).toContain('<script>')
    expect(option.textContent).toContain('⟨U+202E⟩')
    expect(option.textContent).not.toContain(String.fromCodePoint(0x202e))
    // Chosen, the whole path is shown through the untrusted-name pattern.
    fireEvent.change(within(form).getByLabelText('Target'), { target: { value: PROD } })
    const chosen = await waitFor(() => {
      const found = form.querySelector('[data-chosen-target]')
      if (found === null) throw new Error('no chosen target yet')
      return found
    })
    expect(chosen.textContent).toContain('<script>')
    expect(chosen.textContent).toContain('⟨U+202E⟩')
    expectInert(container)
  })

  it('says a failed target read failed, never that there are no targets, and the ID can still be typed', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    world.on('GET', '/api/v1/targets', () => problem(500, 'INTERNAL', 'The server failed.'))
    const { router, container } = mountApp('/audit', world)
    const form = await filters()
    expect(await within(form).findByText(/Could not read Target list/)).toBeInTheDocument()
    expect(within(form).queryByText(/The read succeeded/)).toBeNull()
    expect(within(form).getByLabelText('Target')).toBeDisabled()
    expect(await axeViolations(container)).toEqual([])
    // Trying again reads again.
    const reads = world.reads('/api/v1/targets').length
    await user.click(within(form).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(world.reads('/api/v1/targets').length).toBeGreaterThan(reads))

    fireEvent.change(within(form).getByLabelText('Target ID'), { target: { value: PROD } })
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    await waitFor(() => expect(router.state.location.href).toBe(`/audit?target=${PROD}`))
  })

  it('names the missing permission when the server refuses the target read', async () => {
    const world = auditWorld()
    world.on('GET', '/api/v1/targets', () => problem(403, 'PERMISSION_DENIED', 'Not permitted.'))
    mountApp('/audit', world)
    const form = await filters()
    expect(
      await within(form).findByText(
        /You do not have access to Target list\. It needs the permission targets\.read/,
      ),
    ).toBeInTheDocument()
    expect(within(form).queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('says a cut target list is partial and an empty registry is empty only after a successful read', async () => {
    const partial = auditWorld({ items: [target()], nextCursor: 'more' })
    mountApp('/audit', partial)
    expect(
      await within(await filters()).findByText(/Only the first 200 are listed/),
    ).toBeInTheDocument()
    cleanup()

    const empty = auditWorld({ items: [], nextCursor: null })
    mountApp('/audit', empty)
    expect(
      await within(await filters()).findByText(/The read succeeded and Target list is empty/),
    ).toBeInTheDocument()
  })
})

describe('a search that finds nothing', () => {
  it('says "No match" with a Reset for a filter, and "No audit events yet" only for an empty log', async () => {
    const user = userEvent.setup()
    const filtered = auditWorld()
    filtered.on('GET', '/api/v1/audit-events', { items: [], nextCursor: null })
    const { router } = mountApp('/audit?result=denied', filtered)
    expect(await screen.findByText('No match')).toBeInTheDocument()
    expect(screen.queryByText('No audit events yet')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reset filters' }))
    await waitFor(() => expect(router.state.location.searchStr).toBe(''))
    cleanup()

    const log = auditWorld()
    log.on('GET', '/api/v1/audit-events', { items: [], nextCursor: null })
    mountApp('/audit', log)
    expect(await screen.findByText('No audit events yet')).toBeInTheDocument()
    expect(screen.queryByText('No match')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull()
  })

  it('never shows "No match" for a search that failed', async () => {
    const world = auditWorld()
    world.on('GET', '/api/v1/audit-events', () => problem(500, 'INTERNAL', 'The server failed.'))
    mountApp('/audit?result=denied', world)
    expect(await screen.findByText('Could not read Audit events')).toBeInTheDocument()
    expect(screen.queryByText('No match')).toBeNull()
  })
})
