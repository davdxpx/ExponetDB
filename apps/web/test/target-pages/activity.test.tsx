import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  auditEvent,
  BIDI,
  HOSTILE,
  mountOps,
  OpsWorld,
  operation,
  PROD_TARGET,
  project,
  TARGET,
  ulid,
  withDefaults,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PAGE = `/t/${TARGET}/activity`
const AUDIT = /\/api\/v1\/audit-events\?/
const OPERATIONS = /\/api\/v1\/operations\?/

function world(): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET)
  return withDefaults(w)
}

async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name })
  const root = heading.closest('[data-slot="page-section"]')
  if (!(root instanceof HTMLElement)) throw new Error(`no section ${name}`)
  return root
}

describe('the activity page', () => {
  it('asks for the operations and the audit events of this target only', async () => {
    const w = world()
    mountOps(PAGE, w)
    await section('Operations')
    await screen.findByRole('list', { name: 'Audit events of this target, newest first' })
    for (const pattern of [OPERATIONS, AUDIT]) {
      const query = new URL(w.callsTo('GET', pattern)[0]?.url ?? '', 'http://x').searchParams
      expect(query.get('target')).toBe('tgt_00000000000000000000000002')
    }
  })

  it('keeps applied and verified apart in an operation row and links the operation and plan', async () => {
    mountOps(PAGE, world())
    const operations = await section('Operations')
    const table = await within(operations).findByRole('table', {
      name: 'Operations on this target, newest first',
    })
    const row = within(table).getAllByRole('row')[1] as HTMLElement
    expect(within(row).getByText('applied')).toBeInTheDocument()
    expect(within(row).getByText('failed')).toBeInTheDocument()
    expect(within(row).getByText('verification_failed')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: `op_${ulid(1)}` })).toHaveAttribute(
      'href',
      `/changes/operations/op_${ulid(1)}`,
    )
    expect(within(row).getByRole('link', { name: 'View plan' })).toHaveAttribute(
      'href',
      `/changes/plans/pln_${ulid(1)}`,
    )
  })

  it('shows an audit event with actor, client marked unverified, action, outcome and links', async () => {
    mountOps(PAGE, world())
    const audit = await section('Audit events')
    const list = await within(audit).findByRole('list', {
      name: 'Audit events of this target, newest first',
    })
    expect(within(list).getByText('human #1')).toBeInTheDocument()
    expect(within(list).getByText('migration.apply (completed)')).toBeInTheDocument()
    expect(within(list).getByText('Succeeded')).toBeInTheDocument()
    expect(within(list).getAllByText(/name not verified/i).length).toBeGreaterThan(0)
    expect(within(list).getByRole('link', { name: 'View plan' })).toHaveAttribute(
      'href',
      `/changes/plans/pln_${ulid(1)}`,
    )
    expect(within(list).getByRole('link', { name: 'View operation' })).toHaveAttribute(
      'href',
      `/changes/operations/op_${ulid(1)}`,
    )
  })

  it('shows a named "not permitted" state, not an empty list, without audit.read', async () => {
    const w = world()
    w.fail('GET', AUDIT, 403, 'PERMISSION_DENIED')
    mountOps(PAGE, w)
    const audit = await section('Audit events')
    expect(await within(audit).findByText('audit.read')).toBeInTheDocument()
    expect(within(audit).getByText(/You do not have access to audit events/)).toBeInTheDocument()
    expect(within(audit).queryByRole('list')).toBeNull()
    expect(within(audit).queryByText(/found no audit events/)).toBeNull()
    // The operations still show.
    expect(
      await screen.findByRole('table', { name: 'Operations on this target, newest first' }),
    ).toBeInTheDocument()
  })

  it('shows a failed audit read as failed, never as empty', async () => {
    const w = world()
    w.fail('GET', AUDIT, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    const audit = await section('Audit events')
    expect(await within(audit).findByText(/Could not read audit events/)).toBeInTheDocument()
    expect(within(audit).queryByText(/found no audit events/)).toBeNull()
  })

  it('says empty only after a successful read', async () => {
    const w = world()
    w.on('GET', AUDIT, { items: [], nextCursor: null })
    w.on('GET', OPERATIONS, { items: [], nextCursor: null })
    mountOps(PAGE, w)
    expect(await screen.findByText(/found no audit events/)).toBeInTheDocument()
    expect(screen.getByText(/found no operations/)).toBeInTheDocument()
  })

  it('says more pages exist and loads them with the cursor', async () => {
    const w = world()
    w.on('GET', AUDIT, (request) =>
      request.url.includes('cursor=c2')
        ? { status: 200, body: { items: [auditEvent(2)], nextCursor: null } }
        : { status: 200, body: { items: [auditEvent(1)], nextCursor: 'c2' } },
    )
    mountOps(PAGE, w)
    const audit = await section('Audit events')
    expect(await within(audit).findByText(/Showing part of audit events/)).toBeInTheDocument()
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.setup().click(within(audit).getByRole('button', { name: 'Load more' }))
    await within(audit).findByText('human #2')
    expect(within(audit).getByText('human #1')).toBeInTheDocument()
  })

  it('renders hostile actor, client and reason text as marked text', async () => {
    const w = world()
    w.on('GET', AUDIT, {
      items: [
        auditEvent(1, {
          actor: { identityId: null, kind: 'human', label: HOSTILE },
          client: { clientId: null, grantId: null, kind: 'mcp', sessionId: null },
          reason: `because ${HOSTILE}`,
        }),
      ],
      nextCursor: null,
    })
    w.on('GET', OPERATIONS, {
      items: [operation(1, { kind: 'migration.apply', errorCode: null })],
      nextCursor: null,
    })
    mountOps(PAGE, w)
    const audit = await section('Audit events')
    await within(audit).findByRole('list', { name: 'Audit events of this target, newest first' })
    expect(audit.querySelector('script')).toBeNull()
    expect(audit.textContent).toContain('⟨U+202E⟩')
    expect(audit.textContent).not.toContain(BIDI)
  })

  it('says Production by the title of a production target', async () => {
    const w = new OpsWorld()
    project(w)
    w.sample(PROD_TARGET)
    withDefaults(w, PROD_TARGET)
    mountOps(`/t/${PROD_TARGET}/activity`, w)
    await screen.findByRole('table', { name: 'Operations on this target, newest first' })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="page-header-production-cue"]')).not.toBeNull(),
    )
  })

  it('has no accessibility violations', async () => {
    mountOps(PAGE, world())
    await screen.findByRole('table', { name: 'Operations on this target, newest first' })
    await screen.findByRole('list', { name: 'Audit events of this target, newest first' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
