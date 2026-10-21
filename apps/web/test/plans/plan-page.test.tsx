import '@testing-library/jest-dom/vitest'
import type { ApprovalQueueItem, PlanRead } from '@exponetdb/sdk/operations'
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
  nodeEnrollPlan,
  OP,
  OTHER_IDENTITY,
  operationFor,
  PLAN,
  SERVER,
  SHY,
  serverRecord,
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

/** The page header once the plan is shown (its state badge is there). */
async function pageHeader(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector('[data-slot="page-header"]')
    if (
      !(element instanceof HTMLElement) ||
      element.querySelector('[data-header-facts]') === null
    ) {
      throw new Error('no plan header yet')
    }
    return element
  })
}

/** Mounts the page and returns its header, for a plan without an operation. */
async function mountAndHeader(world: World) {
  const mounted = mountApp(`/changes/plans/${PLAN}`, world)
  const header = await pageHeader()
  return { ...mounted, header }
}

async function openReview(world: World, path = `/changes/plans/${PLAN}`) {
  const mounted = mountApp(path, world)
  const header = await pageHeader()
  const card = await waitFor(() => {
    const element = document.querySelector(`li.card[data-operation="${OP}"]`)
    if (!(element instanceof HTMLElement)) throw new Error('no review card yet')
    return element
  })
  return { ...mounted, header, card }
}

/** The row of the checklist with this id. */
function check(id: string): HTMLElement {
  const row = document.querySelector(`[data-plan-checklist] [data-check="${id}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`no ${id} row`)
  return row
}

/** The visible text of a subtree without the spoken names of marked characters. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element
  for (const sr of clone.querySelectorAll('.sr-only')) sr.remove()
  return clone.textContent ?? ''
}

/** The production chips of the page: tier chips and cue chips, never the frame itself. */
function productionChips(): Element[] {
  return [
    ...document.querySelectorAll('[data-tier="production"]:not([data-plan-frame])'),
    ...document.querySelectorAll('[data-production-cue]'),
  ]
}

describe('the plan review page', () => {
  it('reads top-down: title, state, actions, the checklist, what changes, then the details', async () => {
    const world = queueWorld()
    const { header, card } = await openReview(world)
    expect(card).toHaveClass('card', 'focused')
    // The title says what happens, with the target path as text.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Apply 1 migration to shop/platform/production',
    )
    // A used plan shows where its change stands: the state of its operation.
    await waitFor(() =>
      expect(header.querySelector('[data-operation-state="awaiting_approval"]')).toHaveTextContent(
        'Awaiting approval',
      ),
    )
    expect(header.querySelector('[data-plan-state]')).toBeNull()
    expect(header).toHaveTextContent('Created by you via MCP (an AI agent)')
    // The decision is in the header, not in the review.
    const actions = header.querySelector('[data-slot="page-header-actions"]') as HTMLElement
    expect(within(actions).getByRole('button', { name: 'Approve' })).toHaveClass('primary')
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull()
    const review = card.querySelector('.review') as HTMLElement
    const parts = [
      review.querySelector('.computed [data-plan-checklist]'),
      review.querySelector('[data-plan-section="changes"] [data-plan-block="analysis"]'),
      review.querySelector('[data-plan-section="changes"] .raw'),
      review.querySelector('[data-plan-details]'),
    ]
    for (const part of parts) expect(part).toBeInstanceOf(HTMLElement)
    for (let i = 1; i < parts.length; i += 1) {
      expect(
        (parts[i - 1] as Element).compareDocumentPosition(parts[i] as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    // Every statement with its line before any raw text; the drop is marked destructive.
    const analysis = parts[1] as HTMLElement
    const rows = [...analysis.querySelectorAll('tr[data-statement]')]
    expect(rows.map((row) => row.querySelector('td:nth-child(3)')?.textContent)).toEqual([
      'ALTER TABLE',
      'DROP TABLE',
    ])
    expect(analysis.querySelectorAll('tr.destructive')).toHaveLength(1)
    // up.sql carries the statement facts; verify.sql never does. Every file is shown.
    const raw = parts[2] as HTMLElement
    const files = [...raw.querySelectorAll('section.source')]
    expect(files.map((f) => f.getAttribute('data-file'))).toEqual(['up.sql', 'verify.sql'])
    expect(files[0]?.querySelectorAll('tbody tr.statement-start')).toHaveLength(2)
    expect(files[1]?.querySelectorAll('tbody tr.statement-start')).toHaveLength(0)
    expect(files[0]?.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(raw.textContent).not.toContain('This page shows')
  })

  it('keeps the technical details closed, with the full plan hash and its copy button', async () => {
    const user = userEvent.setup()
    const world = queueWorld()
    const { card } = await openReview(world)
    const details = card.querySelector('details[data-plan-details]') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('code.full-hash')?.textContent).toBe(HASH)
    await user.click(within(details).getByText('Technical details'))
    expect(details.open).toBe(true)
    expect(within(details).getByRole('button', { name: 'Copy plan hash' })).toBeVisible()
    expect(within(details).getByRole('button', { name: 'Copy plan ID' })).toBeVisible()
    expect(details.querySelector('[data-fact="kind"]')).toHaveTextContent('migration.apply')
    expect(details.querySelector('[data-fact="creator"]')).toHaveTextContent(IDENTITY)
    expect(details.querySelector('[data-plan-class="high"]')).not.toBeNull()
    expect(details.querySelector('[data-fact="rules"]')).toHaveTextContent(
      'migration.agent-production',
    )
  })

  it('renders hostile names and text as marked text, never as markup or a link', async () => {
    const world = queueWorld()
    const { card } = await openReview(world)
    const review = card.querySelector('.review') as HTMLElement
    for (const tag of ['script', 'img', 'b', 'iframe']) {
      expect(review.querySelectorAll(tag), tag).toHaveLength(0)
    }
    // The only link is the page's own link to the operation, never one from the plan.
    expect(
      [...review.querySelectorAll('a')].map((a) => a.getAttribute('data-operation-link')),
    ).toEqual([''])
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
    // The rule message from the server is text too, in the policy row.
    expect(visibleText(check('policy'))).toContain(
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

  it('marks production once: one chip beside the title, the frame and one sentence', async () => {
    const world = queueWorld()
    const { header, card } = await openReview(world)
    const frame = card.querySelector('[data-plan-frame]')
    expect(frame).toHaveAttribute('data-tier', 'production')
    const chips = productionChips()
    expect(chips).toHaveLength(1)
    expect(header.querySelector('[data-slot="page-header-production-cue"]')).toContainElement(
      chips[0] as HTMLElement,
    )
    const notices = document.querySelectorAll('[data-production-notice]')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toHaveTextContent('This plan changes production.')
    // No block repeats it.
    for (const block of card.querySelectorAll('[data-plan-block], [data-plan-checklist]')) {
      expect(block).not.toHaveTextContent(/^Production/)
      expect(block.querySelector('[data-tier="production"]')).toBeNull()
    }
  })

  it('notes an agent-made plan in the approvals row and offers no self-approval box for it', async () => {
    const world = queueWorld()
    const { card } = await openReview(world)
    const approvals = check('approvals')
    expect(approvals.querySelector(`#agent-note-${OP}`)).toHaveTextContent(
      'An agent proposed this plan; it cannot approve it.',
    )
    expect(approvals).toHaveTextContent('0 of 1 approval given.')
    expect(approvals).toHaveAttribute('data-check-state', 'waiting')
    expect(approvals).toHaveTextContent('You can approve this plan.')
    expect(within(card).queryByRole('checkbox')).toBeNull()
  })

  it('treats a plan without a tier as production, says why, and a nonprod plan has no frame', async () => {
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
    expect(document.querySelector('[data-production-notice]')).toHaveTextContent(
      'This plan has no target tier; it is treated as production.',
    )
    expect(productionChips()).toHaveLength(1)
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
    expect(productionChips()).toHaveLength(0)
    expect(document.querySelector('[data-production-notice]')).toBeNull()
    expect(document.querySelector('[id^="agent-note-"]')).toBeNull()
    expect(document.querySelector('[data-agent-note]')).toBeNull()
    // The staging evidence is a condition of production only.
    expect(document.querySelector('[data-check="evidence"]')).toBeNull()
  })

  it('titles a node enrollment by its server, says the missing tier, and shows no "not known" row', async () => {
    const world = new World()
    world.plans.set(PLAN, nodeEnrollPlan())
    world.servers.set(SERVER, serverRecord('tour host'))
    mountApp(`/changes/plans/${PLAN}`, world)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Enroll a node on server tour host' }),
    ).toBeInTheDocument()
    const header = await pageHeader()
    expect(header).toHaveTextContent('Created by you via Web App')
    // The creator's id is a technical detail, never the main text.
    expect(header.textContent).not.toContain(IDENTITY)
    expect(header).toHaveTextContent(/Expires in/)
    expect(document.querySelector('[data-production-notice]')).toHaveTextContent(
      'This plan has no target tier; it is treated as production.',
    )
    expect(productionChips()).toHaveLength(1)
    // Facts that do not apply to a node plan are left out, not shown as "not known".
    const details = document.querySelector('[data-plan-details]') as HTMLElement
    for (const fact of [
      'classifications',
      'client-name',
      'schema-fingerprint',
      'newest-backup',
      'rules',
      'requirements',
      'target',
      'operation',
    ]) {
      expect(details.querySelector(`[data-fact="${fact}"]`), fact).toBeNull()
    }
    expect(details.querySelector('[data-fact="server"]')).toHaveTextContent(SERVER)
    expect(details.querySelector('[data-plan-tier="none"]')).toHaveTextContent(
      'None; the page treats the plan as production',
    )
    expect(document.querySelector('main')?.querySelectorAll('[data-not-known]')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('not known')
    // No evidence row: it is a condition of migrations.
    expect(document.querySelector('[data-check="evidence"]')).toBeNull()
    // The stored change is data in a closed disclosure.
    const change = document.querySelector('details[data-plan-block="change"]') as HTMLDetailsElement
    expect(change.open).toBe(false)
    expect(change).toHaveTextContent('No text in it can approve anything')
    expect(change.querySelector('[data-untrusted]')?.textContent).toContain(SERVER)
  })

  it('names the server by its id in the title when its record failed to read', async () => {
    const world = new World()
    world.plans.set(PLAN, nodeEnrollPlan())
    world.failures.set(`GET /api/v1/servers/${SERVER}`, {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry is unavailable.',
    })
    mountApp(`/changes/plans/${PLAN}`, world)
    const title = await screen.findByRole('heading', { level: 1, name: /Enroll a node on server/ })
    await waitFor(() => expect(title).toHaveTextContent(`Enroll a node on server ${SERVER}`))
    expect(title.querySelector('[data-title-subject="id"]')).not.toBeNull()
  })

  it('titles a plan of two migrations, and a hostile server name stays text', async () => {
    const plan = hostilePlan({ state: 'active', operationId: null })
    const content = plan.change?.content as Record<string, unknown>
    const world = new World()
    world.plans.set(PLAN, {
      ...plan,
      change: {
        ...plan.change,
        content: {
          ...content,
          migrations: [
            ...(content['migrations'] as unknown[]),
            { migrationId: '01M4S9000000000000000000AZ', name: 'second', revision: 1 },
          ],
        },
      },
    } as PlanRead)
    mountApp(`/changes/plans/${PLAN}`, world)
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Apply 2 migrations to shop/platform/production',
      }),
    ).toBeInTheDocument()
    cleanup()
    const hostile = new World()
    hostile.plans.set(PLAN, nodeEnrollPlan())
    hostile.servers.set(SERVER, serverRecord(`<b>host</b>${BIDI}`))
    mountApp(`/changes/plans/${PLAN}`, hostile)
    const title = await screen.findByRole('heading', { level: 1, name: /Enroll a node on server/ })
    await waitFor(() => expect(visibleText(title)).toContain(`<b>host</b>${label(0x202e)}`))
    expect(title.querySelector('b')).toBeNull()
    expect(title.textContent).not.toContain(BIDI)
  })

  it('lists the checks in their states: passed, waiting and blocked', async () => {
    const world = queueWorld()
    await openReview(world)
    expect(check('policy')).toHaveAttribute('data-check-state', 'waiting')
    expect(check('policy')).toHaveTextContent('Allowed once approved.')
    expect(check('policy')).toHaveTextContent('migration.agent-production')
    expect(check('approvals')).toHaveAttribute('data-check-state', 'waiting')
    expect(check('evidence')).toHaveAttribute('data-check-state', 'passed')
    expect(check('evidence')).toHaveTextContent(
      'Applied and verified with the same checksum on the evidence environment',
    )
    expect(check('expiry')).toHaveAttribute('data-check-state', 'passed')
    expect(check('expiry')).toHaveTextContent('Accepted for apply before it expired.')
    // Waiting for its approval: nothing ran yet, so applied and verified both wait.
    await waitFor(() => expect(check('apply')).toHaveAttribute('data-outcome', 'not_started'))
    expect(check('apply')).toHaveAttribute('data-check-state', 'waiting')
    expect(check('verification')).toHaveAttribute('data-check-state', 'waiting')
    cleanup()
    const denied = new World()
    denied.plans.set(
      PLAN,
      hostilePlan({ decision: 'deny', state: 'denied', operationId: null, policyRules: [] }),
    )
    mountApp(`/changes/plans/${PLAN}`, denied)
    await pageHeader()
    expect(check('policy')).toHaveAttribute('data-check-state', 'blocked')
    expect(check('policy')).toHaveTextContent('Denied by the policy.')
    // With no rule that failed, the policy row lists none.
    expect(check('policy').querySelector('[data-rule]')).toBeNull()
    expect(check('expiry')).toHaveAttribute('data-check-state', 'blocked')
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('shows a failed read of the operation as failed in its row, never as passed or empty', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    world.failures.set(`GET /api/v1/operations/${OP}`, {
      status: 500,
      code: 'INTERNAL',
      message: 'The operation store is unavailable.',
    })
    await openReview(world)
    const row = await waitFor(() => {
      const element = check('operation')
      if (element.getAttribute('data-check-state') !== 'failed') throw new Error('not failed yet')
      return element
    })
    expect(row).toHaveTextContent(
      'Could not read the operation that applies this plan: The operation store is unavailable. (INTERNAL)',
    )
    expect(document.querySelector('[data-check="apply"]')).toBeNull()
    world.failures.delete(`GET /api/v1/operations/${OP}`)
    world.operations.set(OP, operationFor(OP))
    await user.click(within(row).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(check('apply')).toHaveAttribute('data-outcome', 'not_started'))
  })

  it('approves from the header through the plan confirmation with exactly the shown hash', async () => {
    const user = userEvent.setup()
    const world = queueWorld()
    const { header } = await openReview(world)
    await user.click(within(header).getByRole('button', { name: 'Approve' }))
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

  it('needs the own-plan acknowledgement in the approvals row before approving, then sends it', async () => {
    const user = userEvent.setup()
    const world = queueWorld(hostileItem({ ownPlan: true, actorClient: 'web' }))
    world.plans.set(
      PLAN,
      hostilePlan({ actor: { identityId: IDENTITY, kind: 'human', via: 'web' } }),
    )
    const { header } = await openReview(world)
    const approve = within(header).getByRole('button', { name: 'Approve' })
    expect(approve).toHaveAttribute('aria-disabled', 'true')
    expect(approve).toHaveAccessibleDescription(
      'This is your own plan. Tick the acknowledgement under Approvals to approve it.',
    )
    await user.click(approve)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await user.click(
      within(check('approvals')).getByRole('checkbox', { name: /This is my own plan/ }),
    )
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
    const { header } = await openReview(world)
    await user.click(within(header).getByRole('button', { name: 'Approve' }))
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
    const { header } = await openReview(world)
    await user.click(within(header).getByRole('button', { name: 'Approve' }))
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
    const { header } = await openReview(world)
    await user.click(within(header).getByRole('button', { name: 'Approve' }))
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
    const { header } = await openReview(world)
    await user.click(within(header).getByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Approve this plan?' })
    // A standard plan is confirmed with the action alone.
    await user.click(within(dialog).getByRole('button', { name: 'Approve plan' }))
    expect(
      await screen.findByText(
        'Approved. The plan can be applied from 2026-10-13 08:15 UTC, with a fresh confirmation.',
      ),
    ).toHaveClass('status')
  })

  it('offers the release of the person’s own cooled-down approval as an apply in the header', async () => {
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
    const { header } = await openReview(world)
    expect(
      within(header).getByText(
        'You approved this plan; it can be applied from 2026-10-13 08:15 UTC.',
      ),
    ).toBeInTheDocument()
    // The decision so far is listed in the approvals row.
    expect(check('approvals').querySelector('[data-approval]')).toHaveTextContent('Self-approval')
    await user.click(within(header).getByRole('button', { name: 'Apply' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply this plan?' })
    await user.type(
      within(dialog).getByLabelText(/To confirm, type the target path/),
      'shop/platform/production',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Apply plan' }))
    await waitFor(() => expect(world.posts(`/plans/${PLAN}/apply`)).toHaveLength(1))
    expect(await screen.findByText(`Operation ${OP} is queued.`)).toHaveClass('status')
  })

  it('rejects from the header through a confirmation with the shown hash', async () => {
    const user = userEvent.setup()
    const world = queueWorld()
    const { header } = await openReview(world)
    await user.click(within(header).getByRole('button', { name: 'Reject' }))
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
    await waitFor(() =>
      expect(within(check('approvals')).getByText('You cannot approve this plan.')).toBeVisible(),
    )
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    // Without the review, the stored files are "not known", never an empty list.
    expect(card.querySelector('.raw')).toHaveTextContent('The files of this plan are not known.')
    expect(card.querySelector('.client-name')).toBeNull()
    // The plan was made through a client whose name the page could not read: "not known".
    expect(card.querySelector('[data-fact="client-name"] [data-not-known]')).not.toBeNull()
  })

  it('shows a partial read when the queue cannot be read: eligibility is not known', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    world.operations.set(OP, operationFor(OP))
    world.failures.set('GET /api/v1/approvals', { status: 500, code: 'INTERNAL', message: 'Boom.' })
    await openReview(world)
    expect(
      within(check('approvals')).getByText(
        'Whether you can approve this plan is not known, so no decision is offered.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(
      await screen.findByText(/Could not read the approvals queue: Boom\. \(INTERNAL\)/),
    ).toBeInTheDocument()
  })

  it('offers no action on a stale read of the plan and says it may be out of date', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan({ state: 'active', operationId: null }))
    const { queryClient, header } = await mountAndHeader(world)
    expect(await within(header).findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    world.failures.set(`GET /api/v1/plans/${PLAN}`, {
      status: 503,
      code: 'UNAVAILABLE',
      message: 'The plan store is unavailable.',
    })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['plans', 'detail', PLAN] })
    })
    expect(await screen.findByText(/may be out of date/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull())
    // The plan stays shown as it was read, with its title.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Apply 1 migration to')
  })

  it('shows applied and verified as separate rows and offers Verify again only when retryable', async () => {
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
    await waitFor(() => expect(check('apply')).toHaveAttribute('data-outcome', 'applied'))
    // Applied is not verified: the apply row has no verdict, the verification row is blocked.
    expect(check('apply')).toHaveAttribute('data-check-state', 'neutral')
    expect(check('verification')).toHaveAttribute('data-outcome', 'error')
    expect(check('verification')).toHaveAttribute('data-check-state', 'blocked')
    expect(card.querySelector('[data-check-state="passed"][data-indicator]')).toBeNull()
    expect(
      within(card).getByText('Inspect the operation and the target before you do anything else.'),
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
    expect(
      within(check('apply')).getByRole('link', { name: 'Open the operation page' }),
    ).toHaveAttribute('href', `/changes/operations/${OP}`)
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
    expect(check('apply')).toHaveAttribute('data-check-state', 'blocked')
  })

  it('offers apply in the header through the typed confirmation, and withholds it once expired', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, hostilePlan({ state: 'active', operationId: null }))
    mountApp(`/changes/plans/${PLAN}`, world)
    const header = await pageHeader()
    const apply = await within(header).findByRole('button', { name: 'Apply' })
    // No operation yet: the operation row waits; the plan's other checks show their state.
    expect(check('operation')).toHaveAttribute('data-check-state', 'waiting')
    expect(check('expiry')).toHaveTextContent(/Valid until 2099-10-13 09:00 UTC/)
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
    expect(check('expiry')).toHaveAttribute('data-check-state', 'blocked')
    expect((await pageHeader()).querySelector('[data-expiry="expired"]')).toHaveTextContent(
      'Expired',
    )
    // Announced once, through a status region that was there before.
    expect(screen.getByText('This plan expired.')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('offers Withdraw in the header only on the person’s own active plan made in the Web App', async () => {
    const world = new World()
    world.plans.set(
      PLAN,
      hostilePlan({
        state: 'active',
        operationId: null,
        actor: { identityId: OTHER_IDENTITY, kind: 'human', via: 'web' },
      }),
    )
    mountApp(`/changes/plans/${PLAN}`, world)
    const header = await pageHeader()
    expect(header).toHaveTextContent('Created by a person via Web App')
    expect(header.textContent).not.toContain(OTHER_IDENTITY)
    expect(within(header).getByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(within(header).queryByRole('button', { name: 'Withdraw plan' })).toBeNull()
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
    // While the plan is not read, the title is the page's name and no action is offered.
    expect(screen.getByRole('heading', { level: 1, name: 'Plan review' })).toBeInTheDocument()
    expect(document.querySelector('[data-slot="page-header-actions"]')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const world = queueWorld(hostileItem({ ownPlan: true }))
    await openReview(world)
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no accessibility violations for a node plan with its details open', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, nodeEnrollPlan())
    world.servers.set(SERVER, serverRecord())
    mountApp(`/changes/plans/${PLAN}`, world)
    await screen.findByRole('heading', { level: 1, name: 'Enroll a node on server tour host' })
    await user.click(screen.getByText('Technical details'))
    await user.click(screen.getByText('Stored change'))
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })
})
