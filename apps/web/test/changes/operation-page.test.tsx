import '@testing-library/jest-dom/vitest'
import { focusManager } from '@tanstack/react-query'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { operationPolling } from '../../src/features/changes/model.ts'
import {
  BIDI,
  ChangesWorld,
  HASH,
  hostileItem,
  hostilePlan,
  mountChanges,
  nodeEnrollPlan,
  OP,
  OP2,
  operationFor,
  PLAN,
  SERVER,
  serverRecord,
  ZWSP,
} from './support.tsx'

const DEFAULT_POLLING = { ...operationPolling }

afterEach(() => {
  cleanup()
  Object.assign(operationPolling, DEFAULT_POLLING)
  focusManager.setFocused(undefined)
})

beforeEach(() => {
  focusManager.setFocused(true)
})

const label = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`

function worldWith(over: Parameters<typeof operationFor>[1] = {}): ChangesWorld {
  const world = new ChangesWorld()
  world.plans.set(PLAN, hostilePlan())
  world.operations.set(OP, operationFor(OP, over))
  return world
}

async function openOperation(world: ChangesWorld, id = OP) {
  const mounted = mountChanges(`/changes/operations/${id}`, world)
  await screen.findByRole('heading', { level: 1, name: /Operation/ })
  const frame = await waitFor(() => {
    const element = document.querySelector(`[data-plan-frame][data-operation="${id}"]`)
    if (!(element instanceof HTMLElement)) throw new Error('no operation yet')
    return element
  })
  const header = document.querySelector('[data-slot="page-header"]') as HTMLElement
  return { ...mounted, frame, header }
}

const outcomeOf = (frame: HTMLElement) =>
  frame.querySelector('[data-plan-block="outcome"]') as HTMLElement

describe('the operation page', () => {
  it('renders "page not found" for a path that is not an operation id, and requests nothing', async () => {
    for (const bad of ['op_x', 'OP_01M4S9000000000000000000AA', 'op_01M4S9000000000000000000A']) {
      const world = new ChangesWorld()
      mountChanges(`/changes/operations/${bad}`, world)
      expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
      expect(world.gets('/api/v1/operations')).toEqual([])
      cleanup()
    }
  })

  it('renders "page not found" for an operation the server does not show', async () => {
    mountChanges(`/changes/operations/${OP}`, new ChangesWorld())
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('shows the loading state while the operation is read', async () => {
    const world = worldWith()
    world.held.add(`GET /api/v1/operations/${OP}`)
    mountChanges(`/changes/operations/${OP}`, world)
    expect(await screen.findByRole('heading', { level: 1, name: /Operation/ })).toBeVisible()
    await waitFor(() => expect(document.querySelector('[data-state="loading"]')).not.toBeNull())
    expect(document.querySelector('[data-plan-frame]')).toBeNull()
  })

  it('shows a failed read as failed, never as an empty page', async () => {
    const world = worldWith()
    world.failures.set(`GET /api/v1/operations/${OP}`, {
      status: 500,
      code: 'INTERNAL',
      message: 'The operation store is unavailable.',
    })
    mountChanges(`/changes/operations/${OP}`, world)
    expect(await screen.findByText('The operation store is unavailable.')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no Operation.')).toBeInTheDocument()
    expect(document.querySelector('[data-plan-frame]')).toBeNull()
  })

  it('frames a production operation, links its plan and keeps apply and verify apart', async () => {
    const world = worldWith({
      state: 'verifying',
      applyOutcome: 'applied',
      verificationOutcome: 'pending',
    })
    const { frame } = await openOperation(world)
    expect(frame).toHaveAttribute('data-tier', 'production')
    // Production is said once: the chip beside the title, the frame and one sentence.
    expect(within(frame).getByText('This operation changes production.')).toBeInTheDocument()
    expect(
      screen
        .getByRole('heading', { level: 1 })
        .parentElement?.querySelector('[data-tier="production"]'),
    ).not.toBeNull()
    expect(
      document.querySelectorAll('[data-tier="production"]:not([data-plan-frame])'),
    ).toHaveLength(1)
    expect(document.querySelectorAll('[data-production-notice]')).toHaveLength(1)
    // The title says what happens; the header names the state and who started it.
    // The count comes from the plan the operation applies, once it is read.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'Apply 1 migration to shop/platform/production',
      ),
    )
    const header = document.querySelector('[data-slot="page-header"]') as HTMLElement
    expect(header).toHaveTextContent('Started by you via MCP (an AI agent)')
    expect(within(header).getByRole('link', { name: 'Review the plan' })).toHaveAttribute(
      'href',
      `/changes/plans/${PLAN}`,
    )
    // The facts are technical details, closed until opened.
    const details = frame.querySelector(
      'details[data-operation-block="facts"]',
    ) as HTMLDetailsElement
    expect(details.open).toBe(false)
    const planLink = within(frame).getByRole('link', { name: `Review plan ${PLAN}` })
    expect(planLink).toHaveAttribute('href', `/changes/plans/${PLAN}`)
    expect(await within(frame).findByText(HASH)).toBeInTheDocument()
    const outcome = outcomeOf(frame)
    expect(outcome.querySelector('[data-indicator="apply"]')).toHaveAttribute(
      'data-outcome',
      'applied',
    )
    expect(outcome.querySelector('[data-indicator="verification"]')).toHaveAttribute(
      'data-outcome',
      'running',
    )
    // Applied is never one success: no done tone and no "succeeded" while verification runs.
    expect(outcome.querySelector('[data-tone="done"]')).toBeNull()
    expect(within(frame).queryByText('Succeeded')).toBeNull()
    expect(frame.querySelector('[data-state="verifying"]')?.textContent).toBe('Verifying')
  })

  it('titles a node operation by the server its plan names, and says why it is production', async () => {
    const world = new ChangesWorld()
    world.plans.set(PLAN, nodeEnrollPlan({ state: 'consumed', operationId: OP }))
    world.servers.set(SERVER, serverRecord('tour host'))
    world.operations.set(
      OP,
      operationFor(OP, {
        kind: 'node.enroll',
        state: 'queued',
        actor: { identityId: 'idn_01M4S9000000000000000000AZ', kind: 'human', via: 'web' },
        subject: { targetId: null, targetPath: null, clusterId: null, nodeId: null, tier: null },
      }),
    )
    const { frame, header } = await openOperation(world)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Enroll a node on server tour host' }),
    ).toBeInTheDocument()
    expect(header).toHaveTextContent('Started by a person via Web App')
    expect(header.textContent).not.toContain('idn_01M4S9000000000000000000AZ')
    expect(
      within(frame).getByText('This operation has no target tier; it is treated as production.'),
    ).toBeInTheDocument()
    expect(
      document.querySelectorAll('[data-tier="production"]:not([data-plan-frame])'),
    ).toHaveLength(1)
    // Cancel is an action of the header while the operation has not started.
    expect(within(header).getByRole('button', { name: 'Cancel operation' })).toBeInTheDocument()
  })

  it('titles an operation read without a path by its plan’s path for the same target only', async () => {
    const world = worldWith({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
      subject: { ...operationFor(OP).subject, targetPath: null },
    })
    await openOperation(world)
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'Apply 1 migration to shop/platform/production',
      ),
    )
    cleanup()
    const other = worldWith({
      subject: {
        ...operationFor(OP).subject,
        targetId: 'tgt_01M4S9000000000000000000AE',
        targetPath: null,
      },
    })
    await openOperation(other)
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'Apply 1 migration to tgt_01M4S9000000000000000000AE',
      ),
    )
  })

  it('shows a non-production operation without the production frame', async () => {
    const world = worldWith({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
      subject: {
        ...operationFor(OP).subject,
        targetPath: 'shop/platform/staging',
        tier: 'nonprod',
      },
    })
    const { frame } = await openOperation(world)
    expect(frame).toHaveAttribute('data-tier', 'nonprod')
    expect(within(frame).queryByText('This operation changes production.')).toBeNull()
    expect(document.querySelector('[data-tier="production"]')).toBeNull()
    expect(within(frame).getByRole('link', { name: /shop/ })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging',
    )
  })

  it('names the target by its id when the read gives no path, never as "no target"', async () => {
    const world = worldWith({
      subject: {
        ...operationFor(OP).subject,
        targetId: 'tgt_01M4S9000000000000000000AE',
        targetPath: null,
      },
    })
    const { frame } = await openOperation(world)
    expect(within(frame).getAllByText('tgt_01M4S9000000000000000000AE').length).toBeGreaterThan(0)
    expect(within(frame).queryByText('No target')).toBeNull()
  })

  it('offers no Verify again when the server says the operation is not retryable', async () => {
    const world = worldWith({
      state: 'needs_attention',
      applyOutcome: 'partially_applied',
      verificationOutcome: 'pending',
      nextAction: 'forward_fix',
      retryable: false,
      errorCode: 'MIGRATION_EXECUTION_FAILED',
    })
    const { frame } = await openOperation(world)
    expect(
      within(frame).getByText('Verification cannot be retried for this operation.'),
    ).toBeInTheDocument()
    expect(within(frame).queryByRole('button', { name: 'Verify again' })).toBeNull()
    expect(within(frame).getByRole('heading', { name: 'Before you act' })).toBeInTheDocument()
    const error = frame.querySelector('[data-operation-block="error"]') as HTMLElement
    expect(within(error).getByText('A migration statement failed.')).toBeInTheDocument()
  })

  it('verifies again on production only after the typed target path, once per press', async () => {
    const user = userEvent.setup()
    const world = worldWith({
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
      nextAction: 'inspect',
      retryable: true,
      errorCode: 'VERIFICATION_ERROR',
    })
    const { frame, header } = await openOperation(world)
    await within(frame).findByText(HASH)
    // Verify again is an action of the page header, not of the frame.
    expect(within(frame).queryByRole('button', { name: 'Verify again' })).toBeNull()
    await user.click(within(header).getByRole('button', { name: 'Verify again' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Verify this change again?' })
    // The plan confirmation: target, class and the full plan hash of the plan.
    expect(within(dialog).getByText(HASH)).toBeInTheDocument()
    const action = within(dialog).getByRole('button', { name: 'Verify change again' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    await user.click(action)
    expect(world.posts(`/operations/${OP}/retry-verification`)).toHaveLength(0)
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    world.held.add(`POST /api/v1/operations/${OP}/retry-verification`)
    await user.dblClick(action)
    await user.click(action)
    await waitFor(() => expect(world.posts(`/operations/${OP}/retry-verification`)).toHaveLength(1))
    await act(async () => {})
    expect(world.posts(`/operations/${OP}/retry-verification`)).toHaveLength(1)
    expect(world.posts(`/operations/${OP}/retry-verification`)[0]?.body).toEqual({})
  })

  it('verifies again on non-production with a plain confirmation and says so', async () => {
    const user = userEvent.setup()
    const world = worldWith({
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
      retryable: true,
      subject: {
        ...operationFor(OP).subject,
        targetPath: 'shop/platform/staging',
        tier: 'nonprod',
      },
    })
    const { header } = await openOperation(world)
    await user.click(within(header).getByRole('button', { name: 'Verify again' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Verify this change again?' })
    await user.dblClick(within(dialog).getByRole('button', { name: 'Verify change again' }))
    await waitFor(() => expect(world.posts(`/operations/${OP}/retry-verification`)).toHaveLength(1))
    expect(
      await screen.findByText(`Verification of operation ${OP} starts again.`),
    ).toBeInTheDocument()
    expect(world.posts(`/operations/${OP}/retry-verification`)).toHaveLength(1)
  })

  it('asks for the typed target path when the plan cannot be read, and says the plan is missing', async () => {
    const user = userEvent.setup()
    const world = worldWith({
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
      retryable: true,
    })
    world.failures.set(`GET /api/v1/plans/${PLAN}`, {
      status: 500,
      code: 'INTERNAL',
      message: 'The plan store is unavailable.',
    })
    await openOperation(world)
    expect(
      await screen.findByText(/Could not read the plan of this operation: The plan store/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Verify again' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Verify this change again?' })
    expect(within(dialog).getByLabelText(/To confirm, type the target path/)).toBeInTheDocument()
  })

  it('cancels an operation that has not started, through a confirmation', async () => {
    const user = userEvent.setup()
    const world = worldWith({ state: 'queued' })
    const { header } = await openOperation(world)
    await user.click(within(header).getByRole('button', { name: 'Cancel operation' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this operation?' })
    expect(dialog).toHaveTextContent(
      'Only the person or client that applied the plan can cancel it.',
    )
    expect(world.posts('/cancel')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel operation' }))
    await waitFor(() => expect(world.posts(`/operations/${OP}/cancel`)).toHaveLength(1))
    expect(await screen.findByText(`Operation ${OP} is canceled.`)).toBeInTheDocument()
  })

  it('shows a refused cancel with its catalog text and code', async () => {
    const user = userEvent.setup()
    const world = worldWith({ state: 'awaiting_approval' })
    world.failures.set(`POST /api/v1/operations/${OP}/cancel`, {
      status: 409,
      code: 'PLAN_BINDING_ACTOR',
      message: 'Only the identity and client that created the plan may use it.',
    })
    const { header } = await openOperation(world)
    await user.click(within(header).getByRole('button', { name: 'Cancel operation' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this operation?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel operation' }))
    expect(
      await within(dialog).findByText(/Only the identity and client that created the plan/),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(/PLAN_BINDING_ACTOR/)).toBeInTheDocument()
  })

  it('offers no cancel once the operation runs', async () => {
    await openOperation(worldWith({ state: 'running' }))
    expect(screen.queryByRole('button', { name: 'Cancel operation' })).toBeNull()
  })

  it('names an unknown error code as unknown, never as text it is not', async () => {
    const world = worldWith({ state: 'failed', applyOutcome: 'not_applied', errorCode: 'NEW_CODE' })
    const { frame } = await openOperation(world)
    const error = frame.querySelector('[data-operation-block="error"]') as HTMLElement
    expect(within(error).getByText(/does not know this code/)).toBeInTheDocument()
  })

  it('shows a stale reading with a note and withholds Verify again until it is read again', async () => {
    const world = worldWith({
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
      retryable: true,
    })
    const { header, queryClient } = await openOperation(world)
    expect(within(header).getByRole('button', { name: 'Verify again' })).toBeInTheDocument()
    world.failures.set(`GET /api/v1/operations/${OP}`, {
      status: 503,
      code: 'UNAVAILABLE',
      message: 'The operation store is unavailable.',
    })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['operations', 'detail', OP] })
    })
    expect(await screen.findByText(/may be out of date/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify again' })).toBeNull()
  })

  it('shows the steps in order and the migrations with apply and verify apart', async () => {
    const world = worldWith({
      state: 'running',
      applyOutcome: 'not_started',
      steps: [
        { index: 1, name: `verify${BIDI}`, state: 'pending', startedAt: null, finishedAt: null },
        {
          index: 0,
          name: 'apply',
          state: 'running',
          startedAt: '2026-10-13T08:00:00.000Z',
          finishedAt: null,
        },
      ],
      migrations: [
        {
          migrationId: '01M4S9000000000000000000AB',
          name: `add_notes<script>`,
          applyOutcome: 'applied',
          verificationOutcome: 'pending',
          errorCode: null,
          sqlstate: null,
          statementIndex: null,
        },
      ],
    })
    const { frame } = await openOperation(world)
    const steps = [...frame.querySelectorAll('[data-plan-block="steps"] li[data-step]')]
    expect(steps.map((step) => step.getAttribute('data-step'))).toEqual(['0', '1'])
    expect(steps[1]?.textContent).toContain(label(0x202e))
    const row = frame.querySelector('[data-operation-block="migrations"] tr[data-migration]')
    expect(row?.querySelector('[data-indicator="apply"]')).toHaveAttribute(
      'data-outcome',
      'applied',
    )
    expect(row?.querySelector('[data-indicator="verification"]')).toHaveAttribute(
      'data-outcome',
      'pending',
    )
    expect(document.querySelector('script')).toBeNull()
  })

  it('renders a hostile client name as marked text with "name not verified", and a hostile path unlinked', async () => {
    const world = worldWith({
      state: 'awaiting_approval',
      subject: {
        ...operationFor(OP).subject,
        targetPath: `shop/platform/prod${BIDI}<script>x</script>`,
      },
    })
    world.queue = [hostileItem()]
    const { frame } = await openOperation(world)
    const facts = frame.querySelector('[data-operation-block="facts"]') as HTMLElement
    expect(await within(facts).findByText(/name not verified/)).toBeInTheDocument()
    expect(facts.textContent).toContain(label(0x200b))
    expect(facts.textContent).toContain(label(0x202e))
    expect(facts.querySelector('b')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(within(facts).queryByRole('link', { name: /shop/ })).toBeNull()
    expect(facts.textContent).toContain('<script>x</script>')
    expect(facts.textContent).not.toContain(ZWSP)
  })

  it('polls while at work, pauses while the tab is hidden and stops once terminal', async () => {
    Object.assign(operationPolling, { activeMs: 40, slowMs: 40, waitingMs: 40, maxMs: 80 })
    const world = worldWith({ state: 'running', updatedAt: new Date().toISOString() })
    await openOperation(world)
    const reads = () => world.gets(`/api/v1/operations/${OP}`).length
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(3))
    // Hidden: the query cache does not poll.
    act(() => focusManager.setFocused(false))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const hidden = reads()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(reads()).toBe(hidden)
    // Visible again and then terminal: one more read, and then none.
    world.operations.set(
      OP,
      operationFor(OP, {
        state: 'succeeded',
        applyOutcome: 'applied',
        verificationOutcome: 'passed',
      }),
    )
    act(() => focusManager.setFocused(true))
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="page-header"] [data-state="succeeded"]'),
      ).not.toBeNull(),
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    const terminal = reads()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(reads()).toBe(terminal)
  })

  it('has no accessibility violations', async () => {
    const world = worldWith({
      state: 'needs_attention',
      applyOutcome: 'applied',
      verificationOutcome: 'error',
      retryable: true,
      errorCode: 'VERIFICATION_ERROR',
      waitingFor: { operationId: OP2 },
    })
    await openOperation(world)
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })
})
