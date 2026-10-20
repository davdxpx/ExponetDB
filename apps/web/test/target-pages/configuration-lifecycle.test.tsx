import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  mountOps,
  nth,
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

const PLAN = `pln_${ulid(77)}`
const POLICY = /\/api\/v1\/policy-settings$/
const SUSPEND = /\/api\/v1\/targets\/[^/]+\/suspend$/
const RESUME = /\/api\/v1\/targets\/[^/]+\/resume$/
const DECOMMISSION = /\/api\/v1\/targets\/[^/]+\/decommission$/

function world(permissions: readonly string[] = ['registry.manage']): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET)
  w.sample(PROD_TARGET)
  withDefaults(w)
  withDefaults(w, PROD_TARGET)
  w.on('GET', POLICY, { rules: [] })
  w.on('POST', SUSPEND, { id: PLAN }, 201)
  w.on('POST', RESUME, { id: PLAN }, 201)
  w.on('POST', DECOMMISSION, { id: PLAN }, 201)
  w.permissions = [...permissions] as OpsWorld['permissions']
  return w
}

async function lifecycle(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name: 'Lifecycle' })
  const root = heading.closest('[data-slot="page-section"]')
  if (!(root instanceof HTMLElement)) throw new Error('no lifecycle section')
  return root
}

function card(section: HTMLElement, kind: string): HTMLElement {
  const found = section.querySelector(`[data-lifecycle-plan="${kind}"]`)
  if (!(found instanceof HTMLElement)) throw new Error(`no ${kind} card`)
  return found
}

const page = (path: string): string => `/t/${path}/configuration`

describe('the lifecycle section of the configuration page', () => {
  it('names the missing permission and offers no control without registry.manage', async () => {
    const w = world([])
    mountOps(page(TARGET), w)
    const section = await lifecycle()
    expect(within(section).getByText('You do not have access to lifecycle changes')).toBeVisible()
    expect(within(section).getByText('registry.manage')).toBeVisible()
    expect(within(section).queryByRole('button')).toBeNull()
    expect(w.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('offers suspend and decommission for an active target, and not resume', async () => {
    mountOps(page(TARGET), world())
    const section = await lifecycle()
    expect(within(section).getByText('This target is active.')).toBeVisible()
    expect(within(section).getByRole('button', { name: 'Plan suspension' })).toBeVisible()
    expect(within(section).getByRole('button', { name: 'Plan decommission' })).toBeVisible()
    expect(within(section).queryByRole('button', { name: 'Plan resumption' })).toBeNull()
  })

  it('checks the reason code before it asks for a confirmation or sends anything', async () => {
    const user = userEvent.setup()
    const w = world()
    mountOps(page(TARGET), w)
    const suspend = card(await lifecycle(), 'suspend')
    await user.click(within(suspend).getByRole('button', { name: 'Plan suspension' }))
    expect(await within(suspend).findByText('Enter a reason code.')).toBeVisible()
    await user.type(within(suspend).getByLabelText('Reason code'), 'Bad Reason!')
    await user.click(within(suspend).getByRole('button', { name: 'Plan suspension' }))
    expect(
      await within(suspend).findByText(/Use lowercase letters, digits and underscores/),
    ).toBeVisible()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(w.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('shows the audit warning for the reason and keeps it permanent and free of personal data', async () => {
    mountOps(page(TARGET), world())
    const suspend = card(await lifecycle(), 'suspend')
    expect(
      within(suspend).getByText(/kept permanently in the audit log\. Do not enter personal data\./),
    ).toBeVisible()
  })

  it('plans a suspension after a confirmation and opens the plan page', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountOps(page(TARGET), w)
    const suspend = card(await lifecycle(), 'suspend')
    await user.type(within(suspend).getByLabelText('Reason code'), 'maintenance_window')
    await user.click(within(suspend).getByRole('button', { name: 'Plan suspension' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Create the suspension plan?')).toBeVisible()
    // Nothing was sent before the confirmation.
    expect(w.calls.filter((call) => call.method === 'POST')).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Create suspension plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    const sent = w.calls.filter((call) => call.method === 'POST')
    expect(sent).toHaveLength(1)
    expect(nth(sent, 0).url).toBe('/api/v1/targets/tgt_00000000000000000000000002/suspend')
    expect(nth(sent, 0).body).toEqual({ reason: 'maintenance_window' })
  })

  it('cancels a confirmation without sending anything', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountOps(page(TARGET), w)
    const suspend = card(await lifecycle(), 'suspend')
    await user.type(within(suspend).getByLabelText('Reason code'), 'maintenance_window')
    await user.click(within(suspend).getByRole('button', { name: 'Plan suspension' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(w.calls.filter((call) => call.method === 'POST')).toEqual([])
    expect(router.state.location.pathname).toBe(page(TARGET))
  })

  it('shows the production cue in the confirmation of a production target', async () => {
    const user = userEvent.setup()
    mountOps(page(PROD_TARGET), world())
    const section = await lifecycle()
    expect(within(section).getAllByText('Production').length).toBeGreaterThan(0)
    const suspend = card(section, 'suspend')
    await user.type(within(suspend).getByLabelText('Reason code'), 'incident')
    await user.click(within(suspend).getByRole('button', { name: 'Plan suspension' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.querySelector('[data-slot="confirm-frame"]')).toHaveAttribute('data-tier', 'prod')
    expect(dialog.textContent).toContain('This changes a production target.')
  })

  it('offers resume, not suspend, for a suspended target and plans it', async () => {
    const user = userEvent.setup()
    const w = world()
    w.update(TARGET, { state: 'suspended' })
    const { router } = mountOps(page(TARGET), w)
    const section = await lifecycle()
    expect(within(section).getByText('This target is suspended.')).toBeVisible()
    expect(within(section).queryByRole('button', { name: 'Plan suspension' })).toBeNull()
    const resume = card(section, 'resume')
    expect(
      within(resume).getByText(/checks the identity marker of the database first/),
    ).toBeVisible()
    await user.type(within(resume).getByLabelText('Reason code'), 'maintenance_done')
    await user.click(within(resume).getByRole('button', { name: 'Plan resumption' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create resumption plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    const sent = w.calls.filter((call) => call.method === 'POST')
    expect(nth(sent, 0).url).toMatch(/\/targets\/tgt_[0-9A-Z]{26}\/resume$/)
    expect(nth(sent, 0).body).toEqual({ reason: 'maintenance_done' })
  })

  it('says a registered target is not active yet and offers only decommission', async () => {
    const w = world()
    w.update(TARGET, { state: 'registered' })
    mountOps(page(TARGET), w)
    const section = await lifecycle()
    expect(within(section).getByText(/Suspension applies to active targets/)).toBeVisible()
    expect(within(section).queryByRole('button', { name: 'Plan suspension' })).toBeNull()
    expect(within(section).getByRole('button', { name: 'Plan decommission' })).toBeVisible()
  })

  it('offers nothing for a decommissioned target and says its path is never reused', async () => {
    const w = world()
    w.update(TARGET, { state: 'decommissioned' })
    mountOps(page(TARGET), w)
    const section = await lifecycle()
    expect(
      within(section).getByText(/Its path is never reused, and no lifecycle change/),
    ).toBeVisible()
    expect(within(section).queryByRole('button')).toBeNull()
  })

  it('needs the exact target path typed before a decommission plan can be created', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountOps(page(TARGET), w)
    const section = await lifecycle()
    const danger = card(section, 'decommission')
    expect(within(danger).getByText(/Its path is never reused\./)).toBeVisible()
    await user.type(within(danger).getByLabelText('Reason code'), 'retired_product')
    await user.click(within(danger).getByRole('button', { name: 'Plan decommission' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Create the decommission plan?')).toBeVisible()
    expect(dialog.textContent).toContain('never reused')
    const action = within(dialog).getByRole('button', { name: 'Create decommission plan' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    const field = within(dialog).getByLabelText(/To confirm, type the target path/)
    // A near miss, the wrong case and a prefix do not confirm.
    for (const wrong of ['shop/platform/stagin', 'Shop/platform/staging', 'shop/platform']) {
      fireEvent.change(field, { target: { value: wrong } })
      fireEvent.click(action)
      expect(action).toHaveAttribute('aria-disabled', 'true')
    }
    expect(w.calls.filter((call) => call.method === 'POST')).toEqual([])
    fireEvent.change(field, { target: { value: 'shop/platform/staging' } })
    await waitFor(() => expect(action).not.toHaveAttribute('aria-disabled', 'true'))
    await user.click(action)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    const sent = w.calls.filter((call) => call.method === 'POST')
    expect(sent).toHaveLength(1)
    expect(nth(sent, 0).url).toMatch(/\/targets\/tgt_[0-9A-Z]{26}\/decommission$/)
    expect(nth(sent, 0).body).toEqual({ reason: 'retired_product' })
  })

  it('cancels a decommission without sending anything', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountOps(page(TARGET), w)
    const danger = card(await lifecycle(), 'decommission')
    await user.type(within(danger).getByLabelText('Reason code'), 'retired_product')
    await user.click(within(danger).getByRole('button', { name: 'Plan decommission' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.change(within(dialog).getByLabelText(/To confirm, type the target path/), {
      target: { value: 'shop/platform/staging' },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(w.calls.filter((call) => call.method === 'POST')).toEqual([])
    expect(router.state.location.pathname).toBe(page(TARGET))
  })

  it('shows the production cue for a production decommission', async () => {
    const user = userEvent.setup()
    mountOps(page(PROD_TARGET), world())
    const danger = card(await lifecycle(), 'decommission')
    await user.type(within(danger).getByLabelText('Reason code'), 'retired_product')
    await user.click(within(danger).getByRole('button', { name: 'Plan decommission' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.querySelector('[data-slot="confirm-frame"]')).toHaveAttribute('data-tier', 'prod')
    expect(within(dialog).getAllByText(/shop\/platform\/production/).length).toBeGreaterThan(0)
  })

  it('shows the server refusal with its code in the dialog and stays on the page', async () => {
    const user = userEvent.setup()
    const w = world()
    w.fail('POST', SUSPEND, 409, 'REGISTRY_CONFLICT')
    const { router } = mountOps(page(TARGET), w)
    const suspend = card(await lifecycle(), 'suspend')
    await user.type(within(suspend).getByLabelText('Reason code'), 'maintenance_window')
    await user.click(within(suspend).getByRole('button', { name: 'Plan suspension' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create suspension plan' }))
    expect(await within(dialog).findByText(/REGISTRY_CONFLICT happened\./)).toBeVisible()
    expect(within(dialog).getByText('REGISTRY_CONFLICT')).toBeVisible()
    expect(router.state.location.pathname).toBe(page(TARGET))
  })

  it('asks for a fresh proof when the server asks, then creates the plan once', async () => {
    const user = userEvent.setup()
    const w = world()
    let attempts = 0
    w.on('POST', SUSPEND, () => {
      attempts += 1
      return attempts === 1
        ? { status: 403, code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' }
        : { status: 201 as const, body: { id: PLAN } }
    })
    w.on('POST', /\/auth\/reauth\/totp$/, { reauthenticatedAt: new Date().toISOString() })
    const { router } = mountOps(page(TARGET), w)
    const suspend = card(await lifecycle(), 'suspend')
    await user.type(within(suspend).getByLabelText('Reason code'), 'maintenance_window')
    await user.click(within(suspend).getByRole('button', { name: 'Plan suspension' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create suspension plan' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.type(
      within(reauth).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(attempts).toBe(2)
  })

  it('has no accessibility violations, with the typed confirmation open', async () => {
    const user = userEvent.setup()
    mountOps(page(TARGET), world())
    const section = await lifecycle()
    expect(await axeViolations(document.body)).toEqual([])
    const danger = card(section, 'decommission')
    await user.type(within(danger).getByLabelText('Reason code'), 'retired_product')
    await user.click(within(danger).getByRole('button', { name: 'Plan decommission' }))
    await screen.findByRole('alertdialog')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
