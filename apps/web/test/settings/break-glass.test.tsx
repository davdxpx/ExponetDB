import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { breakGlass, breakGlassList } from '../admin/fixtures.ts'
import {
  BGL,
  BGL2,
  BIDI,
  confirmWithCode,
  expectInert,
  HOSTILE,
  ME,
  mountApp,
  problem,
  T0,
  TAG,
  World,
  ZWSP,
} from '../admin/support.tsx'

afterEach(cleanup)

function grantsWorld(items = [breakGlass()]): World {
  const world = new World()
  world.on('GET', '/api/v1/break-glass-grants', breakGlassList(items))
  world.on('GET', '/api/v1/products', { items: [], nextCursor: null })
  return world
}

function card(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`li[data-grant="${id}"]`)
  if (found === null) throw new Error(`no grant ${id}`)
  return found
}

const ACTIVATE = /activate|break the glass|use break-glass/i

describe('the break-glass page', () => {
  it('lists each grant with target, tier, activator, time box, uses and its reason as text', async () => {
    const world = grantsWorld([
      breakGlass({ reason: `${HOSTILE}\n${BIDI} ${TAG} ${ZWSP}` }),
      breakGlass({
        grantId: BGL2,
        state: 'revoked',
        revokedAt: T0,
        target: {
          path: 'shop/app/staging',
          targetId: 'tgt_01JZ0000000000000000000002',
          tier: 'nonprod',
        },
        review: { note: `Reviewed: ${HOSTILE}`, reviewedAt: T0, reviewedBy: { identityId: ME } },
      }),
    ])
    const { container } = mountApp('/settings/break-glass', world)
    await waitFor(() => expect(card(BGL)).toBeInTheDocument())
    const text = card(BGL).textContent ?? ''
    expect(text).toContain('shop/app/production')
    expect(text).toContain('Production')
    expect(text).toContain(ME)
    expect(text).toContain('1 of 3 uses')
    expect(text).toContain('migration.lock-risk')
    expect(text).toContain('<script>')
    expect(text).toContain('⟨U+202E⟩')
    expect(text).toContain('⟨U+E0041⟩')
    expect(text).toContain('⟨U+200B⟩')
    expect(card(BGL)).toHaveAttribute('data-review', 'open')
    expect(card(BGL2)).toHaveAttribute('data-review', 'done')
    expect(card(BGL2).textContent).toContain('Reviewed: <script>')
    expect(within(card(BGL2)).queryByRole('button', { name: 'Record review' })).toBeNull()
    expectInert(container)
    expect(await axeViolations(container)).toEqual([])
  })

  it('names activation as not available yet (OD-21) and offers no way to activate', async () => {
    mountApp('/settings/break-glass', grantsWorld())
    expect(
      await screen.findByText('Activating break-glass is not available yet'),
    ).toBeInTheDocument()
    expect(screen.getByText(/OD-21/)).toBeInTheDocument()
    await waitFor(() => expect(card(BGL)).toBeInTheDocument())
    expect(
      screen.queryAllByRole('button').filter((b) => ACTIVATE.test(b.textContent ?? '')),
    ).toEqual([])
    expect(screen.queryAllByRole('link').filter((a) => ACTIVATE.test(a.textContent ?? ''))).toEqual(
      [],
    )
  })

  it('records a review after a confirmation and a fresh proof, with the note exactly as typed', async () => {
    const user = userEvent.setup()
    const world = grantsWorld()
    world.needsProof = true
    const note = 'Hotfix applied.\nRule override was needed for the lock.'
    world.on('POST', `/api/v1/break-glass-grants/${BGL}/review`, (request) => {
      expect(request.body).toEqual({ note })
      return {
        json: breakGlass({ review: { note, reviewedAt: T0, reviewedBy: { identityId: ME } } }),
      }
    })
    mountApp('/settings/break-glass', world)
    await waitFor(() => expect(card(BGL)).toBeInTheDocument())
    const field = within(card(BGL)).getByLabelText('Review note')
    expect(card(BGL).textContent).toContain('kept permanently with the grant')
    expect(card(BGL).textContent).toContain('Do not enter personal data')
    fireEvent.change(field, { target: { value: note } })
    await user.click(within(card(BGL)).getByRole('button', { name: 'Record review' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Record this review permanently',
    })
    expect(dialog.textContent).toContain('Rule override was needed')
    expect(world.changes).toEqual([])
    expect(await axeViolations(document.body)).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Record review' }))
    await confirmWithCode(user)
    await waitFor(() =>
      expect(document.querySelector('p.status')).toHaveTextContent('Review recorded.'),
    )
    expect(world.changes.filter((r) => r.path.endsWith('/review'))).toHaveLength(2)
  })

  it('checks the note: blank, longer than 2000 characters, control or direction characters', async () => {
    const user = userEvent.setup()
    const world = grantsWorld()
    mountApp('/settings/break-glass', world)
    await waitFor(() => expect(card(BGL)).toBeInTheDocument())
    const field = within(card(BGL)).getByLabelText('Review note')
    expect(field).toHaveAttribute('maxlength', '2000')
    const submit = within(card(BGL)).getByRole('button', { name: 'Record review' })

    fireEvent.change(field, { target: { value: '   \n  ' } })
    await user.click(submit)
    expect(
      await within(card(BGL)).findByText(/A note of spaces only is refused/),
    ).toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'x'.repeat(2001) } })
    await user.click(submit)
    expect(await within(card(BGL)).findByText('Use at most 2000 characters.')).toBeInTheDocument()

    fireEvent.change(field, { target: { value: `ok ${BIDI}` } })
    await user.click(submit)
    expect(await within(card(BGL)).findByText(/Remove control characters/)).toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'tab\there' } })
    await user.click(submit)
    expect(await within(card(BGL)).findByText(/Remove control characters/)).toBeInTheDocument()

    fireEvent.change(field, { target: { value: 'x'.repeat(2000) } })
    await user.click(submit)
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(world.changes).toEqual([])
  })

  it('shows a second review (409) and a review of an active grant (409) inside the dialog', async () => {
    const user = userEvent.setup()
    const world = grantsWorld([
      breakGlass(),
      breakGlass({ grantId: BGL2, state: 'active', expiresAt: '2099-01-01T00:00:00Z' }),
    ])
    world.on('POST', `/api/v1/break-glass-grants/${BGL}/review`, () =>
      problem(409, 'CONFLICT', 'This grant was already reviewed.'),
    )
    world.on('POST', `/api/v1/break-glass-grants/${BGL2}/review`, () =>
      problem(409, 'CONFLICT', 'An active grant cannot be reviewed yet.'),
    )
    mountApp('/settings/break-glass', world)
    await waitFor(() => expect(card(BGL2)).toBeInTheDocument())
    expect(card(BGL2).textContent).toContain('This grant is still active')

    for (const [id, message] of [
      [BGL, 'This grant was already reviewed.'],
      [BGL2, 'An active grant cannot be reviewed yet.'],
    ] as const) {
      fireEvent.change(within(card(id)).getByLabelText('Review note'), {
        target: { value: 'Looked at it.' },
      })
      await user.click(within(card(id)).getByRole('button', { name: 'Record review' }))
      const dialog = await screen.findByRole('alertdialog')
      await user.click(within(dialog).getByRole('button', { name: 'Record review' }))
      expect(await within(dialog).findByText(message)).toBeInTheDocument()
      expect(within(dialog).getByText('CONFLICT')).toBeInTheDocument()
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    }
  })

  it('shows a refused or failed read truthfully, and empty only after a read', async () => {
    const world = grantsWorld()
    world.on('GET', '/api/v1/break-glass-grants', () => problem(403, 'PERMISSION_DENIED', 'No.'))
    mountApp('/settings/break-glass', world)
    expect(
      await screen.findByText(/You do not have access to Break-glass grants/),
    ).toBeInTheDocument()
    expect(screen.queryByText('No break-glass grants')).toBeNull()
    cleanup()

    const failing = grantsWorld()
    failing.on('GET', '/api/v1/break-glass-grants', () =>
      problem(503, 'CONTROL_PLANE_DEGRADED', 'Down.'),
    )
    mountApp('/settings/break-glass', failing)
    expect(
      await screen.findByText('Could not read Break-glass grants', {}, { timeout: 10_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No break-glass grants')).toBeNull()
    cleanup()

    mountApp('/settings/break-glass', grantsWorld([]))
    expect(await screen.findByText('No break-glass grants')).toBeInTheDocument()
  })
})

describe('the break-glass banner on the settings pages', () => {
  it('names the grants that wait for review and links to the review', async () => {
    const world = grantsWorld([breakGlass(), breakGlass({ grantId: BGL2, state: 'active' })])
    const { container } = mountApp('/settings/products', world)
    const banner = await waitFor(() => {
      const found = document.getElementById('break-glass-banner')
      if (found === null) throw new Error('no banner')
      return found
    })
    expect(banner.textContent).toContain('Break-glass grants waiting for their review: 1')
    expect(banner.textContent).toContain('Still active, to be reviewed after they end: 1.')
    expect(within(banner).getByRole('link', { name: 'Review break-glass grants' })).toHaveAttribute(
      'href',
      '/settings/break-glass',
    )
    expect(world.reads('/api/v1/break-glass-grants')[0]?.search.get('review')).toBe('open')
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows no banner when nothing waits, says when it could not tell, and never reads without policy.manage', async () => {
    mountApp('/settings/products', grantsWorld([]))
    await screen.findByText('No products yet')
    expect(document.getElementById('break-glass-banner')).toBeNull()
    cleanup()

    const failing = grantsWorld()
    failing.on('GET', '/api/v1/break-glass-grants', () =>
      problem(503, 'CONTROL_PLANE_DEGRADED', 'Down.'),
    )
    mountApp('/settings/products', failing)
    await waitFor(
      () =>
        expect(document.getElementById('break-glass-banner')?.textContent).toContain(
          'This does not mean none do.',
        ),
      { timeout: 10_000 },
    )
    cleanup()

    const viewer = grantsWorld()
    viewer.permissions = ['targets.read']
    mountApp('/settings/products', viewer)
    await screen.findByText('No products yet')
    expect(viewer.reads('/api/v1/break-glass-grants')).toHaveLength(0)
  })
})
