import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { chain, event } from '../admin/fixtures.ts'
import {
  BIDI,
  CLIENT,
  cacheText,
  confirmWithCode,
  deferred,
  expectInert,
  GRANT,
  HOSTILE,
  mountApp,
  problem,
  T0,
  TAG,
  World,
} from '../admin/support.tsx'

afterEach(cleanup)

const VERIFIED = chain({
  anchorCheckpointSeq: 100,
  fromSeq: 100,
  scope: 'from_checkpoint',
  status: 'verified',
  throughSeq: 120,
  verifiedAt: T0,
  verifiedEvents: 21,
})

function auditWorld(): World {
  const world = new World()
  world.on('GET', '/api/v1/audit-events/chain', VERIFIED)
  world.on('GET', '/api/v1/audit-events', { items: [event()], nextCursor: null })
  return world
}

function indicator(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#audit-chain [data-chain]')
  if (found === null) throw new Error('no chain indicator')
  return found
}

describe('the chain verification indicator', () => {
  it('says "verified up to sequence N at time T" only for a verified chain', async () => {
    const { container } = mountApp('/audit', auditWorld())
    await waitFor(() => expect(indicator()).toHaveAttribute('data-chain', 'verified'))
    expect(indicator().textContent).toContain('Chain verified up to sequence 120')
    expect(document.querySelector('#audit-chain')?.textContent).toContain(
      'sequence 100 through 120',
    )
    expect(await axeViolations(container)).toEqual([])
  })

  it('announces a broken chain with its sequence and reason', async () => {
    const world = auditWorld()
    world.on(
      'GET',
      '/api/v1/audit-events/chain',
      chain({
        anchorCheckpointSeq: 100,
        failingSeq: 107,
        reason: 'hash_mismatch',
        scope: 'from_checkpoint',
        status: 'broken',
        verifiedAt: T0,
        verifiedEvents: 7,
      }),
    )
    mountApp('/audit', world)
    await waitFor(() => expect(indicator()).toHaveAttribute('data-chain', 'broken'))
    expect(indicator()).toHaveAttribute('role', 'alert')
    expect(indicator().textContent).toContain('Chain broken at sequence 107')
    expect(document.querySelector('#audit-chain')?.textContent).toContain(
      'An event’s hash does not match its content.',
    )
  })

  it('says "not verified yet" with the reason, never verified, when the server did not walk the chain', async () => {
    const world = auditWorld()
    world.on(
      'GET',
      '/api/v1/audit-events/chain',
      chain({
        anchorCheckpointSeq: null,
        eventsSinceAnchor: 12_345,
        limit: 10_000,
        reason: 'too_many_events',
        status: 'not_verified',
      }),
    )
    mountApp('/audit', world)
    await waitFor(() => expect(indicator()).toHaveAttribute('data-chain', 'not_checked'))
    const panel = document.querySelector('#audit-chain')?.textContent ?? ''
    expect(panel).toContain('Not verified yet.')
    expect(panel).toContain('More than 10000 events (12345)')
    expect(panel).not.toContain('Chain verified')
  })

  it('shows loading, and a failed read as unknown: neither intact nor broken', async () => {
    const world = auditWorld()
    const hold = deferred()
    world.on('GET', '/api/v1/audit-events/chain', async () => {
      await hold.promise
      return problem(503, 'CONTROL_PLANE_DEGRADED', 'The Control Store is degraded.')
    })
    const { container } = mountApp('/audit', world)
    await waitFor(() => expect(indicator()).toHaveAttribute('data-chain', 'loading'))
    hold.resolve()
    await waitFor(() => expect(indicator()).toHaveAttribute('data-chain', 'unreadable'), {
      timeout: 10_000,
    })
    expect(indicator().textContent).toContain('This does not mean the chain is intact or broken.')
    expect(indicator().textContent).not.toContain('verified up to')
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('the audit search', () => {
  it('keeps only filter values of the exact shapes from the address and never echoes the others', async () => {
    const world = auditWorld()
    const hostileTarget = encodeURIComponent(`tgt_${HOSTILE}`)
    mountApp(
      `/audit?actor=self&client=${CLIENT}&grant=${GRANT}&result=denied&action=migration.apply&target=${hostileTarget}&from=yesterday&to=2026-10-14T00:00:00Z`,
      world,
    )
    await waitFor(() => expect(world.reads('/api/v1/audit-events').length).toBeGreaterThan(0))
    const query = world.reads('/api/v1/audit-events')[0]?.search
    expect(query?.get('actor')).toBe('self')
    expect(query?.get('client')).toBe(CLIENT)
    expect(query?.get('grant')).toBe(GRANT)
    expect(query?.get('result')).toBe('denied')
    expect(query?.get('action')).toBe('migration.apply')
    expect(query?.get('to')).toBe('2026-10-14T00:00:00Z')
    expect(query?.has('target')).toBe(false)
    expect(query?.has('from')).toBe(false)
    expect(document.body.textContent).not.toContain('<script>')
    expect(document.body.textContent).not.toContain('yesterday')
  })

  it('puts checked filters into the address and refuses a value of the wrong shape', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    const { router } = mountApp('/audit', world)
    const form = await waitFor(() => {
      const found = document.getElementById('audit-filters')
      if (found === null) throw new Error('no filters')
      return found
    })
    fireEvent.change(within(form).getByLabelText('Client ID'), { target: { value: 'cli_nope' } })
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    expect(await within(form).findByText(/Expected: A cli_ ID/)).toBeInTheDocument()
    expect(router.state.location.searchStr).toBe('')

    fireEvent.change(within(form).getByLabelText('Client ID'), { target: { value: CLIENT } })
    await user.selectOptions(within(form).getByLabelText('Outcome'), 'failed')
    await user.click(within(form).getByRole('button', { name: 'Search audit events' }))
    await waitFor(() =>
      expect(router.state.location.href).toBe(`/audit?client=${CLIENT}&result=failed`),
    )
    await waitFor(() =>
      expect(world.reads('/api/v1/audit-events').at(-1)?.search.get('client')).toBe(CLIENT),
    )
  })

  it('shows the events as text and the details of one with links through the allowlist only', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    world.on('GET', '/api/v1/audit-events', {
      items: [
        event({
          reason: `${HOSTILE} ${BIDI}`,
          actor: { identityId: null, kind: 'system', label: TAG },
        }),
        event({
          id: 'aud_01JZ0000000000000000000002',
          action: 'migration.apply',
          refs: {
            jobId: null,
            operationId: 'op_bad',
            planHash: null,
            planId: 'javascript:alert(1)',
          },
          subject: {
            clusterId: null,
            nodeId: null,
            targetId: null,
            targetPath: `shop/${HOSTILE}/production`,
            tier: 'prod',
          },
          denial: { action: 'migration.apply', reason: HOSTILE, tool: null },
          result: { errorCode: 'POLICY_DENIED', status: 'denied' },
        }),
      ],
      nextCursor: null,
    })
    const { container } = mountApp('/audit', world)
    const table = await waitFor(() => {
      const found = document.getElementById('audit-events')
      if (found === null) throw new Error('no table')
      return found
    })
    expect(table.textContent).toContain('⟨U+E0041⟩')
    expectInert(container)

    await user.click(
      screen.getByRole('button', { name: 'Show details of event aud_01JZ0000000000000000000001' }),
    )
    let details = document.getElementById('audit-event-details')
    expect(details?.textContent).toContain('<script>')
    expect(details?.textContent).toContain('⟨U+202E⟩')
    const links = [...(details?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))
    expect(links).toEqual([
      '/changes/plans/pln_01JZ0000000000000000000001',
      '/changes/operations/op_01JZ0000000000000000000001',
      '/t/shop/app/production/migrations',
    ])
    expect(await axeViolations(container)).toEqual([])

    await user.click(
      screen.getByRole('button', { name: 'Show details of event aud_01JZ0000000000000000000002' }),
    )
    details = document.getElementById('audit-event-details')
    expect(details?.textContent).toContain('POLICY_DENIED')
    // A malformed plan id, operation id or target path never becomes a link.
    expect(details?.querySelectorAll('a')).toHaveLength(0)
    expectInert(container)
  })

  it('shows a failed search as a failure, never as an empty log, and empty only after a read', async () => {
    const world = auditWorld()
    world.on('GET', '/api/v1/audit-events', () =>
      problem(503, 'CONTROL_PLANE_DEGRADED', 'The view cannot vouch for a stored event.'),
    )
    mountApp('/audit', world)
    expect(
      await screen.findByText('Could not read Audit events', {}, { timeout: 10_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No audit events yet')).toBeNull()
    cleanup()

    const empty = auditWorld()
    empty.on('GET', '/api/v1/audit-events', { items: [], nextCursor: null })
    mountApp('/audit?result=denied', empty)
    // A filtered search that finds nothing is "No match" with a way back, not an empty log.
    expect(await screen.findByText('No match')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument()
    expect(screen.queryByText('No audit events yet')).toBeNull()
  })

  it('never calls a first page without items but with a cursor an empty log, and offers the older events', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    world.on('GET', '/api/v1/audit-events', (request) =>
      request.search.get('cursor') === 'older'
        ? { json: { items: [event({ id: 'aud_01JZ0000000000000000000003' })], nextCursor: null } }
        : { json: { items: [], nextCursor: 'older' } },
    )
    mountApp('/audit', world)
    expect(await screen.findByText(/None of the newest events read so far matches/)).toBeVisible()
    expect(screen.queryByText('No audit events yet')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Show older events' }))
    await waitFor(() =>
      expect(
        document.querySelector('[data-event="aud_01JZ0000000000000000000003"]'),
      ).not.toBeNull(),
    )
  })

  it('reads older events through the server cursor', async () => {
    const user = userEvent.setup()
    const world = auditWorld()
    world.on('GET', '/api/v1/audit-events', (request) =>
      request.search.get('cursor') === 'older'
        ? { json: { items: [event({ id: 'aud_01JZ0000000000000000000003' })], nextCursor: null } }
        : { json: { items: [event()], nextCursor: 'older' } },
    )
    mountApp('/audit', world)
    await user.click(await screen.findByRole('button', { name: 'Show older events' }))
    await waitFor(() =>
      expect(
        document.querySelector('[data-event="aud_01JZ0000000000000000000003"]'),
      ).not.toBeNull(),
    )
    expect(screen.getByText('All 2 matching events are shown.')).toBeInTheDocument()
  })
})

describe('the audit export', () => {
  const HEADER = {
    type: 'header',
    format: 'exponetdb.audit-export/v1',
    chain: 'ac1',
    from: null,
    to: null,
    firstSeq: 1,
    lastSeq: 2,
    count: 2,
    more: true,
    nextCursor: 'c2',
    checkpoints: [],
    generatedAt: T0,
  }
  const LINE = JSON.stringify({
    type: 'event',
    seq: 1,
    prevHash: 'g',
    hash: 'h',
    event: { seq: 1 },
  })
  let saved: { text: Promise<string>; type: string }[] = []
  let clicks: { href: string; download: string }[] = []

  beforeEach(() => {
    saved = []
    clicks = []
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((blob: Blob) => {
          saved.push({ text: blob.text(), type: blob.type })
          return `blob:http://localhost/${saved.length}`
        }),
        revokeObjectURL: vi.fn(),
      }),
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ href: this.href, download: this.download })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function exportWorld(): World {
    const world = auditWorld()
    world.proofFor.add('/api/v1/audit-events/export')
    world.on('GET', '/api/v1/audit-events/export', (request) => {
      const header =
        request.search.get('cursor') === 'c2'
          ? { ...HEADER, firstSeq: 3, lastSeq: 3, count: 1, more: false, nextCursor: null }
          : HEADER
      return new Response(`${JSON.stringify(header)}\n${LINE}\n`, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    })
    return world
  }

  it('downloads only after a fresh proof, without an Authorization header, and offers the next part', async () => {
    const user = userEvent.setup()
    const world = exportWorld()
    const { container, queryClient } = mountApp('/audit', world)
    const section = await waitFor(() => {
      const found = document.getElementById('audit-export')
      if (found === null) throw new Error('no export')
      return found
    })
    expect(section.textContent).toContain('The file holds full events with personal data')
    expect(section.textContent).toContain('exponetdb-docs/02-control-plane/audit.md, section 5.1')
    // The procedure is named as text, never as an external link.
    expect(section.querySelectorAll('a')).toHaveLength(0)
    expect(await axeViolations(container)).toEqual([])

    fireEvent.change(within(section).getByLabelText('From (optional)'), {
      target: { value: '2026-10-01T00:00:00Z' },
    })
    await user.click(within(section).getByRole('button', { name: 'Download audit export' }))
    await confirmWithCode(user)
    await waitFor(() => expect(clicks).toHaveLength(1))
    const exports = world.reads('/api/v1/audit-events/export')
    // Refused once for the missing proof, then sent once more.
    expect(exports).toHaveLength(2)
    for (const request of exports) {
      expect(Object.keys(request.headers).map((h) => h.toLowerCase())).not.toContain(
        'authorization',
      )
      expect(request.search.get('from')).toBe('2026-10-01T00:00:00Z')
    }
    expect(clicks[0]?.download).toBe('exponetdb-audit-1-2.ndjson')
    expect(clicks[0]?.href).toMatch(/^blob:http:\/\/localhost\//)
    expect(saved[0]?.type).toBe('application/x-ndjson')
    expect(await saved[0]?.text).toBe(`${JSON.stringify(HEADER)}\n${LINE}\n`)
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
    expect(
      within(section).getByText('Downloaded 2 events, sequence 1 through 2.'),
    ).toBeInTheDocument()
    expect(cacheText(queryClient)).not.toContain('exponetdb.audit-export')

    await user.click(within(section).getByRole('button', { name: 'Download the next part' }))
    await waitFor(() => expect(clicks).toHaveLength(2))
    const next = world.reads('/api/v1/audit-events/export').at(-1)
    expect(next?.search.get('cursor')).toBe('c2')
    expect(next?.search.get('from')).toBe('2026-10-01T00:00:00Z')
    expect(clicks[1]?.download).toBe('exponetdb-audit-3-3.ndjson')
    expect(within(section).queryByRole('button', { name: 'Download the next part' })).toBeNull()
  })

  it('downloads nothing when the proof is canceled', async () => {
    const user = userEvent.setup()
    const world = exportWorld()
    mountApp('/audit', world)
    const section = await waitFor(() => {
      const found = document.getElementById('audit-export')
      if (found === null) throw new Error('no export')
      return found
    })
    await user.click(within(section).getByRole('button', { name: 'Download audit export' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.click(within(reauth).getByRole('button', { name: 'Cancel' }))
    expect(await within(section).findByText('Canceled. Nothing was changed.')).toBeInTheDocument()
    expect(clicks).toHaveLength(0)
    expect(world.reads('/api/v1/audit-events/export')).toHaveLength(1)
  })

  it('refuses a malformed range before any request', async () => {
    const user = userEvent.setup()
    const world = exportWorld()
    mountApp('/audit', world)
    const section = await waitFor(() => {
      const found = document.getElementById('audit-export')
      if (found === null) throw new Error('no export')
      return found
    })
    fireEvent.change(within(section).getByLabelText('Until (optional)'), {
      target: { value: 'tomorrow' },
    })
    await user.click(within(section).getByRole('button', { name: 'Download audit export' }))
    expect(
      await within(section).findByText(/Enter a sequence number or a UTC time/),
    ).toBeInTheDocument()
    expect(world.reads('/api/v1/audit-events/export')).toHaveLength(0)
  })

  it('offers no export without policy.manage', async () => {
    const world = exportWorld()
    world.permissions = ['audit.read']
    mountApp('/audit', world)
    expect(
      await screen.findByText(/Exporting needs the permission policy.manage/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download audit export' })).toBeNull()
  })
})
