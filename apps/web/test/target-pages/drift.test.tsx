import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  driftCheck,
  finding,
  mountOps,
  OpsWorld,
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

const PAGE = `/t/${TARGET}/drift`
const FINDINGS = /\/api\/v1\/findings\?/
const ACCEPT = /\/api\/v1\/findings\/[^/]+\/accept$/

function world(items = [finding(1), finding(2, { severity: 'info' })], path = TARGET): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(path)
  withDefaults(w, path)
  w.on('GET', FINDINGS, { items, nextCursor: null })
  return w
}

describe('the drift page: open findings', () => {
  it('lists the open drift findings most severe first with the last time a check saw them', async () => {
    mountOps(PAGE, world([finding(2, { severity: 'info' }), finding(1, { severity: 'critical' })]))
    const table = await screen.findByRole('table', { name: 'Open drift findings of this target' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveAttribute('data-finding', `fnd_${ulid(1)}`)
    expect(screen.getByText(/Last seen by a check/)).toBeInTheDocument()
    expect(screen.getByText('2 open')).toBeInTheDocument()
  })

  it('shows a failed read as failed, never as no drift', async () => {
    const w = world()
    w.fail('GET', FINDINGS, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    expect(await screen.findByText(/Could not read open drift findings/)).toBeInTheDocument()
    expect(screen.queryByText(/found no open drift findings/)).toBeNull()
  })

  it('says there is no drift only after a successful empty read, and offers no acceptance', async () => {
    mountOps(PAGE, world([]))
    expect(await screen.findByText(/found no open drift findings/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept drift' })).toBeNull()
  })

  it('says a longer list is partial', async () => {
    const w = world()
    w.on('GET', FINDINGS, { items: [finding(1)], nextCursor: 'more' })
    mountOps(PAGE, w)
    expect(await screen.findByText(/Showing part of open drift findings/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more findings' })).toBeInTheDocument()
  })

  it('names the missing permission', async () => {
    const w = world()
    w.fail('GET', FINDINGS, 403, 'PERMISSION_DENIED')
    mountOps(PAGE, w)
    expect(await screen.findByText('diagnostics.read')).toBeInTheDocument()
  })
})

describe('the drift page: a check', () => {
  it('runs a check and shows drifted first with expected and actual side by side', async () => {
    const w = world()
    w.on('POST', /\/drift-checks$/, driftCheck(), 201)
    mountOps(PAGE, w)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Run drift check' }))
    const drifted = await waitFor(() => {
      const el = document.querySelector('[data-bucket="drifted"]')
      if (el === null) throw new Error('no drifted bucket')
      return el as HTMLElement
    })
    expect(w.callsTo('POST', /drift-checks$/)).toHaveLength(1)
    const order = [...document.querySelectorAll('[data-bucket]')].map((el) =>
      el.getAttribute('data-bucket'),
    )
    expect(order).toEqual(['drifted', 'unmanaged', 'matched'])
    const table = within(drifted).getByRole('table')
    expect(within(table).getByText('Expected')).toBeInTheDocument()
    expect(within(table).getByText('Actual')).toBeInTheDocument()
    // The server's catalog text is data: markers, never markup.
    expect(drifted.querySelector('script')).toBeNull()
    expect(drifted.textContent).toContain('⟨U+202E⟩')
    expect(drifted.textContent).not.toContain(BIDI)
    // An absent expected value is said, and an operation that explains it is linked.
    const unmanaged = document.querySelector('[data-bucket="unmanaged"]') as HTMLElement
    expect(within(unmanaged).getByText('Absent')).toBeInTheDocument()
    expect(
      within(unmanaged).getByRole('link', { name: 'Explained by an operation' }),
    ).toHaveAttribute('href', `/changes/operations/op_${ulid(7)}`)
    // Counts and source.
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('shows a failed check with its message, and does not claim a result', async () => {
    const w = world()
    w.fail('POST', /\/drift-checks$/, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Run drift check' }))
    expect(await screen.findByText('The drift check failed')).toBeInTheDocument()
    expect(document.querySelector('[data-bucket]')).toBeNull()
  })

  it('says a truncated check lists only part of its findings', async () => {
    const w = world()
    w.on('POST', /\/drift-checks$/, driftCheck({ truncated: true }), 201)
    mountOps(PAGE, w)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Run drift check' }))
    expect(await screen.findByText('The check lists only part of its findings')).toBeInTheDocument()
  })
})

describe('accept drift', () => {
  async function openDialog(): Promise<HTMLElement> {
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Accept drift' }))
    return screen.findByRole('alertdialog')
  }

  it('creates a plan without a reason and opens its review page', async () => {
    const w = world([finding(1, { severity: 'warning' })])
    w.on('POST', ACCEPT, { id: `pln_${ulid(8)}` }, 201)
    const { router } = mountOps(PAGE, w)
    const dialog = await openDialog()
    // The reason is permanent: the dialog says so before anything is sent.
    expect(within(dialog).getByText('The reason is permanent')).toBeInTheDocument()
    expect(within(dialog).getByText(/personal data/)).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/changes/plans/pln_${ulid(8)}`),
    )
    const [call] = w.callsTo('POST', ACCEPT)
    expect(call?.url).toBe(`/api/v1/findings/fnd_${ulid(1)}/accept`)
    expect(call?.body).toEqual({})
  })

  it('creates a plan with a reason', async () => {
    const w = world([finding(1)])
    w.on('POST', ACCEPT, { id: `pln_${ulid(8)}` }, 201)
    const { router } = mountOps(PAGE, w)
    const dialog = await openDialog()
    const user = userEvent.setup()
    await user.type(
      within(dialog).getByLabelText(/Reason/),
      'Adopted after the incident review of the read grant',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/changes/plans/pln_${ulid(8)}`),
    )
    expect(w.callsTo('POST', ACCEPT)[0]?.body).toEqual({
      reason: 'Adopted after the incident review of the read grant',
    })
  })

  it('shows reason_required, keeps the dialog open and sends nothing twice', async () => {
    const w = world([finding(1, { severity: 'critical', securityRelevant: true })])
    w.fail('POST', ACCEPT, 422, 'VALIDATION_FAILED', {
      errors: [{ path: '/reason', code: 'reason_required' }],
    })
    const { router } = mountOps(PAGE, w)
    const dialog = await openDialog()
    // A critical finding says up front that a reason is required.
    expect(within(dialog).getByLabelText('Reason (required for this finding)')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    expect(await within(dialog).findByText(/reason_required/)).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(PAGE)
    expect(w.callsTo('POST', ACCEPT)).toHaveLength(1)
  })

  it('refuses a reason shorter than the contract allows before sending it', async () => {
    const w = world([finding(1)])
    w.on('POST', ACCEPT, { id: `pln_${ulid(8)}` }, 201)
    mountOps(PAGE, w)
    const dialog = await openDialog()
    const user = userEvent.setup()
    await user.type(within(dialog).getByLabelText(/Reason/), 'short')
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    expect(
      await within(dialog).findByText('A reason needs at least 10 characters.'),
    ).toBeInTheDocument()
    expect(w.callsTo('POST', ACCEPT)).toHaveLength(0)
  })

  it('shows another refusal with its message and code', async () => {
    const w = world([finding(1)])
    w.fail('POST', ACCEPT, 409, 'REGISTRY_CONFLICT')
    mountOps(PAGE, w)
    const dialog = await openDialog()
    const user = userEvent.setup()
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    expect((await within(dialog).findAllByText(/REGISTRY_CONFLICT/)).length).toBeGreaterThan(0)
  })

  it('says Production on a production target', async () => {
    const w = world([finding(1)], PROD_TARGET)
    mountOps(`/t/${PROD_TARGET}/drift`, w)
    await screen.findByRole('button', { name: 'Accept drift' })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'production',
      ),
    )
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
  })
})

describe('the drift page: accessibility', () => {
  it('has no violations with a check result', async () => {
    const w = world()
    w.on('POST', /\/drift-checks$/, driftCheck(), 201)
    mountOps(PAGE, w)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Run drift check' }))
    await screen.findAllByRole('table')
    await waitFor(() => expect(document.querySelector('[data-bucket="drifted"]')).not.toBeNull())
    expect(await axeViolations(document.body)).toEqual([])
  })
})
