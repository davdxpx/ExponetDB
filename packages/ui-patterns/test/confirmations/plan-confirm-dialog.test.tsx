import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type PlanClass,
  PlanConfirmDialog,
  type PlanConfirmFacts,
} from '../../src/confirmations/plan-confirm-dialog.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const HASH_A = `sha256:${'a1'.repeat(32)}`
const HASH_B = `sha256:${'b2'.repeat(32)}`
const PROD = 'shop/platform/production'

const PLAN: PlanConfirmFacts = {
  planHash: HASH_A,
  tier: 'prod',
  planClass: 'high',
  targetPath: PROD,
}

const base = {
  title: 'Apply the plan',
  description: 'The plan runs its migration bundles on the target, then verifies them.',
  actionLabel: 'Apply to production',
}

function action(): HTMLElement {
  return screen.getByRole('button', { name: 'Apply to production' })
}

function frameOf(): HTMLElement {
  const frame = screen
    .getByRole('alertdialog')
    .querySelector<HTMLElement>('[data-slot="confirm-frame"]')
  if (frame === null) throw new Error('no frame')
  return frame
}

function factValue(term: string): HTMLElement {
  const dt = screen.getByText(term, { selector: 'dt' })
  const dd = dt.nextElementSibling
  if (!(dd instanceof HTMLElement) || dd.tagName !== 'DD') throw new Error(`no value for ${term}`)
  return dd
}

function deferred() {
  let resolve: () => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('PlanConfirmDialog', () => {
  it('shows the target, tier, class and the full plan hash, and has no axe violations', async () => {
    render(<PlanConfirmDialog {...base} plan={PLAN} defaultOpen onConfirm={vi.fn()} />)
    expect(factValue('Target')).toHaveTextContent(PROD)
    expect(factValue('Tier')).toHaveTextContent('Production')
    expect(factValue('Class')).toHaveTextContent('high')
    const hash = factValue('Plan hash').querySelector('code')
    expect(hash).toHaveTextContent(HASH_A)
    expect(hash?.textContent).toBe(HASH_A)
    expect(await axeViolations()).toEqual([])
  })

  it('copies the plan hash and says so', async () => {
    const user = userEvent.setup()
    render(<PlanConfirmDialog {...base} plan={PLAN} defaultOpen onConfirm={vi.fn()} />)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Copy plan hash' }))
    await waitFor(() => expect(screen.getByText('Plan hash copied.')).toBeInTheDocument())
    expect(await navigator.clipboard.readText()).toBe(HASH_A)
    vi.restoreAllMocks()
  })

  it('says when the plan hash could not be copied', async () => {
    const user = userEvent.setup()
    render(<PlanConfirmDialog {...base} plan={PLAN} defaultOpen onConfirm={vi.fn()} />)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: 'Copy plan hash' }))
    await waitFor(() =>
      expect(screen.getByText(/Could not copy the plan hash/)).toBeInTheDocument(),
    )
    vi.restoreAllMocks()
  })

  it.each<PlanClass>(['low', 'standard', 'high', 'critical'])(
    'frames a %s production plan and cues production',
    (planClass) => {
      render(
        <PlanConfirmDialog
          {...base}
          plan={{ ...PLAN, planClass, effect: 'replaces placement of shop/platform/production' }}
          defaultOpen
          onConfirm={vi.fn()}
        />,
      )
      expect(frameOf()).toHaveAttribute('data-tier', 'prod')
      expect(screen.getByText('This changes a production target.')).toBeInTheDocument()
      expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(
        /^Production This changes a production target\. /,
      )
    },
  )

  it('shows no production cue for a non-production plan', () => {
    render(
      <PlanConfirmDialog
        {...base}
        actionLabel="Apply to staging"
        plan={{ ...PLAN, tier: 'nonprod', targetPath: 'shop/platform/staging' }}
        defaultOpen
        onConfirm={vi.fn()}
      />,
    )
    expect(frameOf()).toHaveAttribute('data-tier', 'nonprod')
    expect(screen.queryByText('This changes a production target.')).toBeNull()
    expect(factValue('Tier')).toHaveTextContent('Non-production')
  })

  it.each([undefined, '', 'Nonprod', 'staging'])(
    'fails closed to production for a plan whose tier is %j',
    (tier) => {
      render(
        <PlanConfirmDialog
          {...base}
          plan={{ ...PLAN, tier: tier as unknown as PlanConfirmFacts['tier'] }}
          defaultOpen
          onConfirm={vi.fn()}
        />,
      )
      expect(frameOf()).toHaveAttribute('data-tier', 'prod')
      expect(screen.getByText('This changes a production target.')).toBeInTheDocument()
      expect(factValue('Tier')).toHaveTextContent('Production')
    },
  )

  it.each<PlanClass>(['low', 'standard'])(
    'confirms a %s plan with the action alone and hands back the facts it showed',
    async (planClass) => {
      const user = userEvent.setup()
      const onConfirm = vi.fn()
      render(
        <PlanConfirmDialog
          {...base}
          plan={{ ...PLAN, planClass }}
          defaultOpen
          onConfirm={onConfirm}
        />,
      )
      expect(screen.queryByRole('textbox')).toBeNull()
      await user.click(action())
      expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ ...PLAN, planClass })
    },
  )

  it('needs the target path typed for a high plan', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<PlanConfirmDialog {...base} plan={PLAN} defaultOpen onConfirm={onConfirm} />)

    const input = screen.getByRole('textbox', {
      name: `To confirm, type the target path ${PROD}`,
    })
    await waitFor(() => expect(input).toHaveFocus())
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    expect(action()).toHaveAccessibleDescription(
      'Type the target path exactly as shown to continue.',
    )
    await user.click(action())
    expect(onConfirm).not.toHaveBeenCalled()

    await user.type(input, 'shop/platform/Production')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    await user.clear(input)
    await user.type(input, PROD)
    await user.click(action())
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(PLAN)
  })

  it('shows the effect of a critical plan and needs the target path and the effect typed', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const EFFECT = 'replaces placement of shop/platform/production'
    const critical: PlanConfirmFacts = { ...PLAN, planClass: 'critical', effect: EFFECT }
    render(
      <PlanConfirmDialog {...base} destructive plan={critical} defaultOpen onConfirm={onConfirm} />,
    )
    expect(factValue('Effect')).toHaveTextContent(EFFECT)
    expect(await axeViolations()).toEqual([])
    expect(factValue('Class')).toHaveTextContent('critical: Replaces or destroys data or identity.')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    expect(action()).toHaveAccessibleDescription(
      'Type the target path and the effect exactly as shown to continue.',
    )

    const path = screen.getByRole('textbox', { name: `To confirm, type the target path ${PROD}` })
    const effect = screen.getByRole('textbox', { name: `To confirm, type the effect ${EFFECT}` })
    await waitFor(() => expect(path).toHaveFocus())

    // The path alone is not enough: Enter is an attempt, and the effect field says what is missing.
    await user.type(path, `${PROD}{Enter}`)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(effect).toHaveAttribute('aria-invalid', 'true')
    expect(effect).toHaveAccessibleDescription('Type the text shown above to continue.')

    await user.type(effect, 'replaces placement of shop/platform/staging')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    await user.clear(effect)
    await user.type(effect, `${EFFECT}{Enter}`)
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(critical)
  })

  it('clears both typed fields of a critical plan when its effect changes', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const critical: PlanConfirmFacts = {
      ...PLAN,
      planClass: 'critical',
      effect: 'replaces placement of shop/platform/production',
    }
    const { rerender } = render(
      <PlanConfirmDialog {...base} plan={critical} open onConfirm={onConfirm} />,
    )
    const [path, effect] = screen.getAllByRole('textbox')
    if (path === undefined || effect === undefined) throw new Error('two fields expected')
    await user.type(path, PROD)
    await user.type(effect, 'replaces placement of shop/platform/production')
    expect(action()).not.toHaveAttribute('aria-disabled')

    rerender(
      <PlanConfirmDialog
        {...base}
        plan={{ ...critical, effect: 'decommissions shop/platform/production' }}
        open
        onConfirm={onConfirm}
      />,
    )
    for (const field of screen.getAllByRole('textbox')) expect(field).toHaveValue('')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    await user.click(action())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('fails closed for a critical plan without an effect', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <PlanConfirmDialog
        {...base}
        plan={{ ...PLAN, planClass: 'critical', effect: '  ' }}
        defaultOpen
        onConfirm={onConfirm}
      />,
    )
    expect(factValue('Effect')).toHaveTextContent('Not named')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    expect(action()).toHaveAccessibleDescription(
      'This critical plan names no effect, so it cannot be confirmed here.',
    )
    await user.click(action())
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('needs the typed path for a class it does not know', async () => {
    const onConfirm = vi.fn()
    // A class from a newer server: never confirmed with the action alone.
    const unknown = { ...PLAN, planClass: 'severe' } as unknown as PlanConfirmFacts
    render(<PlanConfirmDialog {...base} plan={unknown} defaultOpen onConfirm={onConfirm} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(factValue('Class')).toHaveTextContent('severe: Not a known class.')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
  })

  it('clears the typed path when the plan hash or tier changes under the open dialog', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <PlanConfirmDialog {...base} plan={PLAN} open onConfirm={onConfirm} />,
    )
    await user.type(screen.getByRole('textbox'), PROD)
    expect(action()).not.toHaveAttribute('aria-disabled')

    // The plan was replaced while the dialog was open: same target, new hash.
    rerender(
      <PlanConfirmDialog
        {...base}
        plan={{ ...PLAN, planHash: HASH_B }}
        open
        onConfirm={onConfirm}
      />,
    )
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    expect(factValue('Plan hash')).toHaveTextContent(HASH_B)
    await user.click(action())
    await user.keyboard('{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()

    await user.type(screen.getByRole('textbox'), PROD)
    rerender(
      <PlanConfirmDialog
        {...base}
        plan={{ ...PLAN, planHash: HASH_B, tier: 'nonprod' }}
        open
        onConfirm={onConfirm}
      />,
    )
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(action()).toHaveAttribute('aria-disabled', 'true')

    await user.type(screen.getByRole('textbox'), PROD)
    await user.click(action())
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
      ...PLAN,
      planHash: HASH_B,
      tier: 'nonprod',
    })
  })

  it('keeps showing the confirmed plan while pending, then the new one after a failure', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onConfirm = vi.fn(() => pending.promise)
    const { rerender } = render(
      <PlanConfirmDialog {...base} plan={PLAN} open onConfirm={onConfirm} />,
    )
    await user.type(screen.getByRole('textbox'), PROD)
    await user.click(action())
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(PLAN)

    rerender(
      <PlanConfirmDialog
        {...base}
        plan={{ ...PLAN, planHash: HASH_B }}
        open
        onConfirm={onConfirm}
      />,
    )
    // Still the plan that was sent.
    expect(factValue('Plan hash')).toHaveTextContent(HASH_A)
    expect(screen.getByRole('textbox')).toHaveValue(PROD)
    expect(action()).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      pending.reject({ code: 'PLAN_STALE', message: 'The plan no longer matches the target.' })
      await pending.promise.catch(() => undefined)
    })
    expect(screen.getByRole('alert')).toHaveTextContent('PLAN_STALE')
    expect(factValue('Plan hash')).toHaveTextContent(HASH_B)
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(action()).toHaveAttribute('aria-disabled', 'true')
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('applies once for a double press and blocks dismissal while pending', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onConfirm = vi.fn(() => pending.promise)
    const onOpenChange = vi.fn()
    render(
      <PlanConfirmDialog
        {...base}
        plan={{ ...PLAN, planClass: 'standard' }}
        defaultOpen
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    )
    const button = action()
    act(() => {
      button.click()
      button.click()
    })
    await user.dblClick(button)
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(button).toHaveFocus()

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('marks hidden characters in the target path and plan hash', () => {
    render(
      <PlanConfirmDialog
        {...base}
        plan={{ ...PLAN, planHash: `${HASH_A}\u200b`, targetPath: `${PROD}\u202e` }}
        defaultOpen
        onConfirm={vi.fn()}
      />,
    )
    expect(within(factValue('Target')).getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(within(factValue('Plan hash')).getByText('⟨U+200B⟩')).toBeInTheDocument()
  })
})
