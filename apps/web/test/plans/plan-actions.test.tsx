import '@testing-library/jest-dom/vitest'
import type { PlanRead } from '@exponetdb/sdk/operations'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  hostileItem,
  hostilePlan,
  IDENTITY,
  MIGRATION,
  mountApp,
  OP,
  OTHER_IDENTITY,
  operationFor,
  PLAN,
  PROJECT,
  storeBundle,
  UP_SQL,
  World,
} from './support.tsx'

afterEach(cleanup)

const label = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`

/** The person's own active plan, made in the Web App, not applied yet. */
function ownActive(over: Partial<PlanRead> = {}): PlanRead {
  return hostilePlan({
    state: 'active',
    operationId: null,
    actor: { identityId: IDENTITY, kind: 'human', via: 'web' },
    ...over,
  } as Partial<PlanRead>)
}

async function summary(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector('[data-plan-block="summary"]')
    if (!(element instanceof HTMLElement)) throw new Error('no summary yet')
    return element
  })
}

async function raw(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector('.review .raw')
    if (!(element instanceof HTMLElement)) throw new Error('no raw block yet')
    return element
  })
}

describe('withdraw a plan', () => {
  it('withdraws the person’s own active plan after a confirmation and shows the withdrawn state', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, ownActive())
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await summary()
    await user.click(await within(block).findByRole('button', { name: 'Withdraw plan' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw this plan?' })
    // The plan is on production: the dialog carries the production frame and names the target.
    expect(dialog.querySelector('[data-slot="confirm-frame"]')).toHaveAttribute('data-tier', 'prod')
    expect(dialog.textContent).toContain('shop/platform/production')
    expect(world.posts('/withdraw')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw plan' }))
    await waitFor(() => expect(world.posts('/withdraw')).toHaveLength(1))
    expect(world.posts('/withdraw')[0]).toMatchObject({
      path: `/api/v1/plans/${PLAN}/withdraw`,
      body: {},
      csrf: 't',
    })
    expect(await screen.findByText('Withdrawn. The plan can no longer be applied.')).toHaveClass(
      'status',
    )
    // The page shows the withdrawn plan: no action is offered on it any more.
    await waitFor(() =>
      expect(within(block).queryByRole('button', { name: 'Withdraw plan' })).toBeNull(),
    )
    expect(within(block).queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(block.textContent).toMatch(/withdrawn/i)
  })

  it('changes nothing when the confirmation is canceled', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, ownActive())
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await summary()
    await user.click(await within(block).findByRole('button', { name: 'Withdraw plan' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw this plan?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(world.posts('/withdraw')).toHaveLength(0)
    expect(within(block).getByRole('button', { name: 'Withdraw plan' })).toBeInTheDocument()
  })

  it('asks for a fresh proof on REAUTH_REQUIRED and withdraws once more', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, ownActive())
    world.reauthNeeded = true
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await summary()
    await user.click(await within(block).findByRole('button', { name: 'Withdraw plan' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw this plan?' })
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw plan' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.type(
      within(reauth).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
    await waitFor(() => expect(world.posts('/withdraw')).toHaveLength(2))
    expect(
      await screen.findByText('Withdrawn. The plan can no longer be applied.'),
    ).toBeInTheDocument()
  })

  it('shows a refusal with its catalog text and code in the dialog', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, ownActive())
    world.failures.set(`POST /api/v1/plans/${PLAN}/withdraw`, {
      status: 403,
      code: 'PLAN_BINDING_ACTOR',
      message: 'The plan belongs to another client.',
    })
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await summary()
    await user.click(await within(block).findByRole('button', { name: 'Withdraw plan' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw this plan?' })
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw plan' }))
    expect(
      await within(dialog).findByText('The plan belongs to another client.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('PLAN_BINDING_ACTOR')).toBeInTheDocument()
  })

  it('is not offered on another person’s plan or on a plan that is no longer active', async () => {
    const world = new World()
    world.plans.set(
      PLAN,
      ownActive({ actor: { identityId: OTHER_IDENTITY, kind: 'human', via: 'web' } }),
    )
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await summary()
    expect(await within(block).findByRole('button', { name: 'Apply' })).toBeInTheDocument()
    expect(within(block).queryByRole('button', { name: 'Withdraw plan' })).toBeNull()
    cleanup()
    const consumed = new World()
    consumed.plans.set(PLAN, ownActive({ state: 'consumed' }))
    mountApp(`/changes/plans/${PLAN}`, consumed)
    const used = await summary()
    expect(within(used).queryByRole('button', { name: 'Withdraw plan' })).toBeNull()
  })
})

describe('the files of a plan, for every reader of it', () => {
  it('reads the files the plan runs from the bundle store and shows them as text with the facts', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    storeBundle(world)
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await raw()
    const up = await waitFor(() => {
      const element = block.querySelector('section.source[data-file="up.sql"]')
      if (!(element instanceof HTMLElement)) throw new Error('no up.sql yet')
      return element
    })
    expect(up.querySelectorAll('tbody tr')).toHaveLength(UP_SQL.split('\n').length)
    expect(up.querySelectorAll('tbody tr.statement-start')).toHaveLength(2)
    const verify = block.querySelector('section.source[data-file="verify.sql"]')
    expect(verify?.querySelectorAll('tbody tr.statement-start')).toHaveLength(0)
    expect(up.textContent).toContain(label(0x202e))
    expect(up.textContent).not.toContain(BIDI)
    expect(up.textContent).toContain('<script>window.__pwned = 1</script>')
    const review = document.querySelector('.review') as HTMLElement
    for (const tag of ['script', 'img', 'a', 'b', 'iframe']) {
      expect(review.querySelectorAll(tag), tag).toHaveLength(0)
    }
    expect(block.textContent).not.toContain('This page shows')
    expect(
      world.gets(`/projects/${PROJECT}/bundles/${MIGRATION}/revisions/1/files/up.sql`),
    ).toHaveLength(1)
  })

  it('names a failed file read (partial) and still shows the files that were read', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    storeBundle(world)
    world.bundleFiles.delete(`${PROJECT}/${MIGRATION}/1/verify.sql`)
    mountApp(`/changes/plans/${PLAN}`, world)
    const stored = await waitFor(() => {
      const element = document.querySelector('[data-stored-files="partial"]')
      if (!(element instanceof HTMLElement)) throw new Error('no partial read yet')
      return element
    })
    expect(stored.textContent).toContain(`verify.sql of ${MIGRATION} could not be read (NOT_FOUND)`)
    expect(stored.querySelector('section.source[data-file="up.sql"]')).not.toBeNull()
    expect(stored.querySelector('.raw')?.textContent).toContain('This page shows 1 of the 2 files')
  })

  it('does not show a stored revision whose digest differs from the one the plan binds', async () => {
    const world = new World()
    const plan = hostilePlan()
    const content = plan.change?.content as Record<string, unknown>
    world.plans.set(PLAN, {
      ...plan,
      change: {
        ...plan.change,
        content: {
          ...content,
          migrations: [
            {
              migrationId: MIGRATION,
              name: 'add-notes',
              revision: 1,
              bundleDigest: `sha256:c1:${'99'.repeat(32)}`,
            },
          ],
        },
      },
    } as PlanRead)
    storeBundle(world)
    mountApp(`/changes/plans/${PLAN}`, world)
    const stored = await waitFor(() => {
      const element = document.querySelector('[data-stored-files="partial"]')
      if (!(element instanceof HTMLElement)) throw new Error('no partial read yet')
      return element
    })
    expect(stored.textContent).toContain('matches the revision and digest this plan binds')
    expect(stored.querySelector('section.source')).toBeNull()
    expect(world.gets('/files/')).toHaveLength(0)
  })

  it('shows a failed bundle read as failed: the files stay not known, never an empty list', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await raw()
    expect(await screen.findByText(/Could not read stored files of this plan/)).toBeInTheDocument()
    expect(block).toHaveTextContent('The files of this plan are not known.')
  })

  it('says the plan names no bundle files only after a successful read (empty)', async () => {
    const world = new World()
    const plan = hostilePlan()
    world.plans.set(PLAN, {
      ...plan,
      change: {
        ...plan.change,
        content: { ...(plan.change?.content as Record<string, unknown>), migrations: [] },
      },
    } as PlanRead)
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await raw()
    expect(
      await within(block).findByText('The server sent no file text for this plan.'),
    ).toBeInTheDocument()
    expect(document.querySelector('[data-stored-files="ready"]')).not.toBeNull()
  })

  it('keeps the approver’s queue review as the source and reads nothing from the bundle store', async () => {
    const world = new World()
    world.queue = [hostileItem()]
    world.plans.set(PLAN, hostilePlan())
    world.operations.set(OP, operationFor(OP))
    storeBundle(world)
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await raw()
    await waitFor(() =>
      expect(block.querySelector('section.source[data-file="up.sql"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-stored-files]')).toBeNull()
    expect(world.gets('/bundles/')).toHaveLength(0)
  })

  it('opens the stored SQL of a bundle of the plan in the side panel', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    storeBundle(world)
    mountApp(`/changes/plans/${PLAN}`, world)
    const bundles = await waitFor(() => {
      const element = document.querySelector('[data-plan-block="bundles"]')
      if (!(element instanceof HTMLElement)) throw new Error('no bundles block yet')
      return element
    })
    // The bundle list is outside the review: it holds buttons only.
    expect(bundles.closest('.review')).toBeNull()
    await user.click(
      within(bundles).getByRole('button', { name: `View SQL of migration ${MIGRATION}` }),
    )
    const sheet = await screen.findByRole('dialog', { name: 'Migration SQL' })
    const up = await waitFor(() => {
      const element = sheet.querySelector('[data-bundle-file="up.sql"]')
      if (!(element instanceof HTMLElement)) throw new Error('no up.sql yet')
      return element
    })
    expect(up.textContent).toContain(label(0x202e))
    expect(sheet.querySelector('script')).toBeNull()
  })

  it('has no accessibility violations with the files read from the bundle store', async () => {
    const world = new World()
    world.plans.set(PLAN, hostilePlan())
    storeBundle(world)
    mountApp(`/changes/plans/${PLAN}`, world)
    const block = await raw()
    await waitFor(() =>
      expect(block.querySelector('section.source[data-file="verify.sql"]')).not.toBeNull(),
    )
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })
})
