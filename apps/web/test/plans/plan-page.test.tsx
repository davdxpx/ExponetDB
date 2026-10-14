import '@testing-library/jest-dom/vitest'
import type { ApprovalQueueItem } from '@exponetdb/sdk/operations'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  HASH,
  hostileItem,
  hostilePlan,
  IDENTITY,
  mountApp,
  OP,
  operationFor,
  PLAN,
  SHY,
  World,
  ZWSP,
} from './support.tsx'

afterEach(cleanup)

const label = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`

function queueWorld(item: ApprovalQueueItem = hostileItem()): World {
  const world = new World()
  world.queue = [item]
  world.plans.set(PLAN, hostilePlan())
  world.operations.set(OP, operationFor(OP))
  return world
}

async function openReview(world: World, path = `/changes/plans/${PLAN}`) {
  const mounted = mountApp(path, world)
  await screen.findByRole('heading', { level: 1, name: /Plan review/ })
  const card = await waitFor(() => {
    const element = document.querySelector(`li.card[data-operation="${OP}"]`)
    if (!(element instanceof HTMLElement)) throw new Error('no review card yet')
    return element
  })
  return { ...mounted, card }
}

/** The visible text of a subtree without the spoken names of marked characters. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element
  for (const sr of clone.querySelectorAll('.sr-only')) sr.remove()
  return clone.textContent ?? ''
}

describe('the plan review page', () => {
  it('shows what ExponetDB computed first, then the stored files as text, with the old hooks', async () => {
    const world = queueWorld()
    const { card } = await openReview(world)
    expect(card).toHaveClass('card', 'focused')
    const review = card.querySelector('.review')
    expect(review).not.toBeNull()
    const computed = review?.querySelector('.computed')
    const raw = review?.querySelector('.raw')
    expect(computed).toBeInstanceOf(HTMLElement)
    expect(raw).toBeInstanceOf(HTMLElement)
    // Computed facts come before the raw text in the document.
    expect(
      (computed as Element).compareDocumentPosition(raw as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(computed?.querySelector('code.full-hash')?.textContent).toBe(HASH)
    expect(within(computed as HTMLElement).getByRole('button', { name: 'Copy plan hash' }))
    // Every statement with its line before any raw text; the drop is marked destructive.
    const rows = [...(computed?.querySelectorAll('tr[data-statement]') ?? [])]
    expect(rows.map((row) => row.querySelector('td:nth-child(3)')?.textContent)).toEqual([
      'ALTER TABLE',
      'DROP TABLE',
    ])
    expect(computed?.querySelectorAll('tr.destructive')).toHaveLength(1)
    // up.sql carries the statement facts; verify.sql never does.
    const files = [...(raw?.querySelectorAll('section.source') ?? [])]
    expect(files.map((f) => f.getAttribute('data-file'))).toEqual(['up.sql', 'verify.sql'])
    expect(files[0]?.querySelectorAll('tbody tr.statement-start')).toHaveLength(2)
    expect(files[1]?.querySelectorAll('tbody tr.statement-start')).toHaveLength(0)
    expect(files[0]?.querySelectorAll('tbody tr')).toHaveLength(3)
    // Every file the plan runs is shown: no "This page shows n of m files" note.
    expect(raw?.textContent).not.toContain('This page shows')
  })

  it('renders hostile names and text as marked text, never as markup or a link', async () => {
    const world = queueWorld()
    const { card } = await openReview(world)
    const review = card.querySelector('.review') as HTMLElement
    for (const tag of ['script', 'img', 'a', 'b', 'iframe']) {
      expect(review.querySelectorAll(tag), tag).toHaveLength(0)
    }
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined()
    // The client's own name: untrusted text with every hidden character by code point, not verified.
    const client = review.querySelector('.client-name [data-untrusted="name"]') as HTMLElement
    expect(visibleText(client)).toBe(
      `ExponetDB Official${label(0x200b)} ✅ <b>trusted</b>${label(0x202e)}name not verified`,
    )
    expect(client.textContent).not.toContain(BIDI)
    expect(client.textContent).not.toContain(ZWSP)
    // Dropped objects, the rewrite estimate and the migration name are marked like the raw text.
    const drops = [...review.querySelectorAll('li.destructive')].map((li) => visibleText(li))
    expect(drops).toEqual([
      `table public.acc${label(0x00ad)}ounts`,
      `table public.${label(0x200b)}secrets`,
    ])
    expect(visibleText(review)).toContain(`public.big${label(0x202e)}`)
    expect(visibleText(review)).toContain(`add${label(0x00ad)}notes`)
    expect(review.textContent).not.toContain(SHY)
    // The raw text: tags and direction characters never act; markup stays text.
    const up = review.querySelector('section.source[data-file="up.sql"]') as HTMLElement
    const text = visibleText(up.querySelector('table.source-text') as Element)
    expect(text).toContain(`${label(0xe0041)}${label(0xe0042)}`)
    expect(text).toContain('<script>window.__pwned = 1</script><img src=x onerror=1>')
    expect(text).toContain(`[Approve](https://evil.example) ${label(0x202e)}gnp.exe`)
    expect(up.textContent).not.toContain(BIDI)
    // The rule message from the server is text too.
    expect(visibleText(review)).toContain(
      `An agent changes production only with a human approval.${label(0x202e)}`,
    )
  })

  it('leaves an unmarked client name as plain text, laid out left to right', async () => {
    const plain = hostileItem()
    const world = queueWorld({
      ...plain,
      review: {
        ...(plain.review as NonNullable<ApprovalQueueItem['review']>),
        clientName: 'Plain Agent',
      },
    })
    const { card } = await openReview(world)
    const name = card.querySelector('.client-name [data-untrusted="name"] > span[dir="ltr"]')
    expect(name?.textContent).toBe('Plain Agent')
    expect([...(name?.childNodes ?? [])].every((n) => n.nodeType === Node.TEXT_NODE)).toBe(true)
  })

  it('frames production, notes an agent-made plan and offers no self-approval box for it', async () => {
    const world = queueWorld()
    const { card } = await openReview(world)
    expect(card.querySelector('[data-plan-frame]')).toHaveAttribute('data-tier', 'production')
    expect(card.querySelector(`#agent-note-${OP}`)).toHaveTextContent(
      'An agent proposed this plan; it cannot approve it.',
    )
    expect(within(card).queryByRole('checkbox')).toBeNull()
    expect(within(card).getByRole('button', { name: 'Approve' })).toHaveClass('primary')
  })

  it('treats a plan without a tier as production and a nonprod plan without the frame', async () => {
    const world = new World()
    world.plans.set(
      PLAN,
      hostilePlan({ subject: { ...hostilePlan().subject, tier: null }, operationId: null }),
    )
    mountApp(`/changes/plans/${PLAN}`, world)
    await waitFor(() =>
      expect(document.querySelector('[data-plan-frame]')).toHaveAttribute(
        'data-tier',
        'production',
      ),
    )
    cleanup()
    const nonprod = new World()
    nonprod.plans.set(
      PLAN,
      hostilePlan({
        subject: { ...hostilePlan().subject, tier: 'nonprod', targetPath: 'shop/platform/staging' },
        operationId: null,
        actor: { identityId: IDENTITY, kind: 'human', via: 'web' },
      }),
    )
    mountApp(`/changes/plans/${PLAN}`, nonprod)
    await waitFor(() =>
      expect(document.querySelector('[data-plan-frame]')).toHaveAttribute('data-tier', 'nonprod'),
    )
    expect(document.querySelector('[id^="agent-note-"]')).toBeNull()
    expect(document.querySelector('[data-agent-note]')).toBeNull()
  })

  it('approves through the plan confirmation with exactly the shown hash and no acknowledgement', async () => {
    const user = userEvent.setup()
    const world = queueWorld()
    const { card } = await openReview(world)
    await user.click(within(card).getByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this plan?' })
    // A high plan: the target path is typed before the approval is available.
    const action = within(dialog).getByRole('button', { name: 'Approve plan' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    expect(within(dialog).getByText(HASH)).toBeInTheDocument()
    await user.click(action)
    await waitFor(() => expect(world.posts('/approve')).toHaveLength(1))
    expect(world.posts('/approve')[0]).toMatchObject({
      path: `/api/v1/approvals/${OP}/approve`,
      body: { planHash: HASH },
      csrf: 't',
    })
    expect(world.posts('/approve')[0]?.body).toEqual({ planHash: HASH })
    expect(await screen.findByText('Approved.')).toHaveClass('status')
  })

  it('needs the own-plan acknowledgement before approving and then sends it', async () => {
    const user = userEvent.setup()
    const world = queueWorld(hostileItem({ ownPlan: true, actorClient: 'web' }))
    world.plans.set(
      PLAN,
      hostilePlan({ actor: { identityId: IDENTITY, kind: 'human', via: 'web' } }),
    )
    const { card } = await openReview(world)
    const approve = within(card).getByRole('button', { name: 'Approve' })
    expect(approve).toHaveAttribute('aria-disabled', 'true')
    expect(approve).toHaveAccessibleDescription(
      'This is your own plan. Tick the acknowledgement above to approve it.',
    )
    await user.click(approve)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await user.click(within(card).getByRole('checkbox', { name: /This is my own plan/ }))
    expect(approve).not.toHaveAttribute('aria-disabled')
    await user.click(approve)
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this plan?' })
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Approve plan' }))
    await waitFor(() => expect(world.posts('/approve')).toHaveLength(1))
    expect(world.posts('/approve')[0]?.body).toEqual({
      planHash: HASH,
      acknowledgeSelfApproval: true,
    })
  })

  it('asks for a fresh proof on REAUTH_REQUIRED and sends the same approval once more', async () => {
    const user = userEvent.setup()
    const world = queueWorld()
    world.reauthNeeded = true
    const { card } = await openReview(world)
    await user.click(within(card).getByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this plan?' })
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Approve plan' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.type(
      within(reauth).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
    await waitFor(() => expect(world.posts('/approve')).toHaveLength(2))
    const [first, second] = world.posts('/approve')
    expect(second?.body).toEqual(first?.body)
    expect(second?.body).toEqual({ planHash: HASH })
    expect(await screen.findByText('Approved.')).toBeInTheDocument()
  })

  it('says "Canceled. Nothing was changed." when the proof is canceled, and sends nothing more', async () => {
    const user = userEvent.setup()
    const world = queueWorld()
    world.reauthNeeded = true
    const { card } = await openReview(world)
    await user.click(within(card).getByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this plan?' })
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Approve plan' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.click(within(reauth).getByRole('button', { name: 'Cancel' }))
    expect(await within(dialog).findByText('Canceled. Nothing was changed.')).toBeInTheDocument()
    expect(within(dialog).getByText('REAUTH_CANCELED')).toBeInTheDocument()
    expect(world.posts('/approve')).toHaveLength(1)
  })

  it('shows a refusal with its catalog text and code, never exception text', async () => {
    const user = userEvent.setup()
    const world = queueWorld()
    world.failures.set('POST /api/v1/approvals', {
      status: 409,
      code: 'PLAN_STALE',
      message: 'The plan is stale.',
    })
    const { card } = await openReview(world)
    await user.click(within(card).getByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this plan?' })
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Approve plan' }))
    expect(await within(dialog).findByText('The plan is stale.')).toBeInTheDocument()
    expect(within(dialog).getByText('PLAN_STALE')).toBeInTheDocument()
  })

  it('says when a critical self-approval cools down before the plan can be applied', async () => {
    const user = userEvent.setup()
    const world = queueWorld(
      hostileItem({
        class: 'standard',
        review: {
          ...hostileItem().review,
          plan: { ...hostilePlan(), class: 'standard' },
        } as ApprovalQueueItem['review'],
      }),
    )
    world.approvalAnswer = (operationId, body) => ({
      id: 'apr_01M4S9000000000000000000AH',
      operationId,
      planId: PLAN,
      planHash: body.planHash,
      approverIdentityId: IDENTITY,
      decision: 'approved',
      selfApproval: true,
      decidedAt: '2026-10-13T08:05:00.000Z',
      notBefore: '2026-10-13T08:15:00.000Z',
    })
    const { card } = await openReview(world)
    await user.click(within(card).getByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this plan?' })
    // A standard plan is confirmed with the action alone.
    await user.click(within(dialog).getByRole('button', { name: 'Approve plan' }))
    expect(
      await screen.findByText(
        'Approved. The plan can be applied from 2026-10-13 08:15 UTC, with a fresh confirmation.',
      ),
    ).toHaveClass('status')
  })

  it('offers the release of the person’s own cooled-down approval as an apply', async () => {
    const user = userEvent.setup()
    const world = queueWorld(
      hostileItem({
        ownPlan: true,
        approvals: [
          {
            id: 'apr_01M4S9000000000000000000AH',
            operationId: OP,
            planId: PLAN,
            planHash: HASH,
            approverIdentityId: IDENTITY,
            decision: 'approved',
            selfApproval: true,
            decidedAt: '2026-10-13T08:05:00.000Z',
            notBefore: '2026-10-13T08:15:00.000Z',
          },
        ],
      }),
    )
    const { card } = await openReview(world)
    expect(
      within(card).getByText(
        'You approved this plan; it can be applied from 2026-10-13 08:15 UTC.',
      ),
    ).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Apply' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply this plan?' })
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Apply plan' }))
    await waitFor(() => expect(world.posts(`/plans/${PLAN}/apply`)).toHaveLength(1))
    expect(await screen.findByText(`Operation ${OP} is queued.`)).toHaveClass('status')
  })

  it('rejects through a confirmation with the shown hash', async () => {
    const user = userEvent.setup()
    const world = queueWorld()
    const { card } = await openReview(world)
    await user.click(within(card).getByRole('button', { name: 'Reject' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Reject this plan?' })
    await user.click(within(dialog).getByRole('button', { name: 'Reject plan' }))
    await waitFor(() => expect(world.posts('/reject')).toHaveLength(1))
    expect(world.posts('/reject')[0]?.body).toEqual({ planHash: HASH })
    expect(await screen.findByText('Rejected; the operation is canceled.')).toBeInTheDocument()
  })

  it('takes eligibility from the server: a plan outside the person’s queue offers no decision', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    world.operations.set(OP, operationFor(OP))
    const { card } = await openReview(world)
    expect(card).not.toHaveClass('focused')
    expect(within(card).getByText('You cannot approve this plan.')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull()
    // Without the review, the stored files are "not known", never an empty list.
    expect(card.querySelector('.raw')).toHaveTextContent('The files of this plan are not known.')
    expect(card.querySelector('.client-name')).toBeNull()
  })

  it('shows a partial read when the queue cannot be read: eligibility is not known', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    world.operations.set(OP, operationFor(OP))
    world.failures.set('GET /api/v1/approvals', { status: 500, code: 'INTERNAL', message: 'Boom.' })
    const { card } = await openReview(world)
    expect(within(card).getByText(/Whether you can approve this plan is/)).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(
      await screen.findByText(/Could not read the approvals queue: Boom\. \(INTERNAL\)/),
    ).toBeInTheDocument()
  })

  it('shows applied and verified as separate indicators and offers Verify again only when retryable', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    world.operations.set(
      OP,
      operationFor(OP, {
        state: 'needs_attention',
        applyOutcome: 'applied',
        verificationOutcome: 'error',
        nextAction: 'inspect',
        retryable: true,
      }),
    )
    const { card } = await openReview(world)
    const outcome = await waitFor(() => {
      const element = card.querySelector('[data-plan-block="outcome"]')
      if (!(element instanceof HTMLElement) || element.querySelector('[data-indicator]') === null) {
        throw new Error('no outcome yet')
      }
      return element
    })
    expect(outcome.querySelector('[data-indicator="apply"]')).toHaveAttribute(
      'data-outcome',
      'applied',
    )
    expect(outcome.querySelector('[data-indicator="verification"]')).toHaveAttribute(
      'data-outcome',
      'error',
    )
    expect(
      within(outcome).getByText(
        'Inspect the operation and the target before you do anything else.',
      ),
    ).toBeInTheDocument()
    expect(within(card).getByRole('heading', { name: 'Before you act' })).toBeInTheDocument()
    // The production plan confirmation: the target path is typed before anything is sent.
    await user.click(within(card).getByRole('button', { name: 'Verify again' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Verify this change again?' })
    expect(world.posts(`/operations/${OP}/retry-verification`)).toHaveLength(0)
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Verify change again' }))
    await waitFor(() => expect(world.posts(`/operations/${OP}/retry-verification`)).toHaveLength(1))
    expect(within(card).getByRole('link', { name: 'Open the operation page' })).toHaveAttribute(
      'href',
      `/changes/operations/${OP}`,
    )
    expect(
      await screen.findByText(`Verification of operation ${OP} starts again.`),
    ).toBeInTheDocument()
  })

  it('does not offer Verify again when the server says the operation is not retryable', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    world.operations.set(
      OP,
      operationFor(OP, {
        state: 'needs_attention',
        applyOutcome: 'partially_applied',
        verificationOutcome: 'pending',
        nextAction: 'forward_fix',
        retryable: false,
      }),
    )
    const { card } = await openReview(world)
    expect(
      await within(card).findByText('Verification cannot be retried for this operation.'),
    ).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Verify again' })).toBeNull()
  })

  it('offers apply on an active plan through the typed confirmation, and withholds it once expired', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, hostilePlan({ state: 'active', operationId: null }))
    mountApp(`/changes/plans/${PLAN}`, world)
    const apply = await screen.findByRole('button', { name: 'Apply' })
    await user.click(apply)
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply this plan?' })
    expect(within(dialog).getByRole('button', { name: 'Apply plan' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Apply plan' }))
    await waitFor(() => expect(world.posts(`/plans/${PLAN}/apply`)).toHaveLength(1))
    expect(world.posts(`/plans/${PLAN}/apply`)[0]?.body).toEqual({})
    cleanup()
    const expired = new World()
    expired.plans.set(
      PLAN,
      hostilePlan({ state: 'active', operationId: null, expiresAt: '2020-01-01T00:00:00.000Z' }),
    )
    mountApp(`/changes/plans/${PLAN}`, expired)
    expect(
      await screen.findByText('This plan expired. Create a new plan to make this change.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('renders "page not found" for a path that is not a plan id, and requests nothing about it', async () => {
    for (const bad of [
      'pln_x',
      'PLN_01M4S9000000000000000000AA',
      'pln_01M4S9000000000000000000A',
      'pln_01M4S9000000000000000000AAA',
      'pln_81M4S9000000000000000000AA',
      'pln_01M4S9000000000000000000IL',
      '%2e%2e',
      'pln_01M4S9000000000000000000A%0A',
    ]) {
      const world = new World()
      mountApp(`/changes/plans/${bad}`, world)
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
        bad,
      ).toBeInTheDocument()
      expect(world.gets('/api/v1/plans')).toEqual([])
      expect(document.body.textContent).not.toContain(decodeURIComponent(bad))
      cleanup()
    }
  })

  it('renders "page not found" for a plan the server does not show, and a failed read as failed', async () => {
    const world = new World()
    mountApp(`/changes/plans/${PLAN}`, world)
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    cleanup()
    const failing = new World()
    failing.failures.set(`GET /api/v1/plans/${PLAN}`, {
      status: 500,
      code: 'INTERNAL',
      message: 'The plan store is unavailable.',
    })
    mountApp(`/changes/plans/${PLAN}`, failing)
    expect(await screen.findByText('The plan store is unavailable.')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no Plan.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const world = queueWorld(hostileItem({ ownPlan: true }))
    await openReview(world)
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })
})
