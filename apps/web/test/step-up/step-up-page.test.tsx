import '@testing-library/jest-dom/vitest'
import type { StepUp } from '@exponetdb/sdk/operations'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { pageReload } from '../../src/features/approvals/fragment-binding.ts'
import { BIDI, HASH, mountApp, STEP_UP, World, ZWSP } from '../plans/support.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SECRET_CODE = 'WXYZ-2345'

function stepUp(over: Partial<StepUp> = {}): StepUp {
  return {
    id: STEP_UP,
    action: 'plan.apply',
    bindingDigest: `sha256:${'aa'.repeat(32)}`,
    clientName: `ExponetDB CLI${ZWSP}${BIDI}`,
    expiresAt: '2026-10-13T08:10:00.000Z',
    planHash: HASH,
    receiptExpiresAt: null,
    state: 'pending',
    // A server that ever sent the code back: the page must neither show nor keep it.
    userCode: SECRET_CODE,
    verificationUri: `https://db.example.test/step-up#id=${STEP_UP}`,
    ...over,
  }
}

function world(over: Partial<StepUp> = {}): World {
  const w = new World()
  w.stepUps.set(STEP_UP, stepUp(over))
  return w
}

async function open(w: World, fragment = `#id=${STEP_UP}`) {
  const mounted = mountApp(`/step-up${fragment}`, w)
  await screen.findByRole('heading', { level: 1, name: 'Confirm a command from your terminal' })
  return mounted
}

describe('the step-up page', () => {
  it('asks for the link the terminal shows when the fragment is not exactly a step-up id', async () => {
    for (const fragment of [
      '',
      '#id=stu_x',
      `#id=${STEP_UP}&x=1`,
      `#ID=${STEP_UP}`,
      `#id=${STEP_UP.toLowerCase()}`,
      '#id=../../account',
      `#id=${STEP_UP}%0A`,
      `#token=${STEP_UP}`,
    ]) {
      const w = world()
      await open(w, fragment)
      expect(
        await screen.findByText('Open the link your terminal shows.'),
        fragment,
      ).toHaveAttribute('id', 'step-up-missing')
      expect(w.gets('/api/v1/step-ups'), fragment).toEqual([])
      cleanup()
    }
  })

  it('shows the client, the action, the plan hash and the expiry, and never the code', async () => {
    const w = world()
    const { queryClient } = await open(w)
    const section = await waitFor(() => {
      const element = document.getElementById('step-up')
      if (element === null) throw new Error('no step-up yet')
      return element
    })
    const client = document.getElementById('step-up-client') as HTMLElement
    expect(client.textContent).toContain('ExponetDB CLI')
    expect(client.textContent).toContain('⟨U+200B⟩')
    expect(client.textContent).toContain('⟨U+202E⟩')
    expect(client.textContent).not.toContain(BIDI)
    expect(document.getElementById('step-up-action')).toHaveTextContent('Apply a plan')
    expect(within(section).getByText(HASH)).toBeInTheDocument()
    expect(within(section).getByText('2026-10-13 08:10 UTC')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(SECRET_CODE)
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET_CODE)
    const code = screen.getByLabelText('Code from the terminal')
    expect(code).toHaveAttribute('id', 'step-up-code')
    expect(code).toHaveAttribute('autocomplete', 'off')
    expect(code).toHaveAttribute('spellcheck', 'false')
    expect(code).toHaveAttribute('maxlength', '9')
    expect(code).toHaveValue('')
    expect(section.querySelectorAll('button.primary')).toHaveLength(1)
    expect(section.querySelector('button.primary')).toHaveTextContent('Confirm command')
  })

  it('names an action it does not know by its id, as marked text', async () => {
    const w = world({ action: `node.reveal${BIDI}`, planHash: null })
    await open(w)
    const action = await waitFor(() => {
      const element = document.getElementById('step-up-action')
      if (element === null) throw new Error('no action yet')
      return element
    })
    expect(action.textContent).toContain('node.reveal⟨U+202E⟩')
    expect(screen.queryByText('Plan hash')).toBeNull()
  })

  it('sends the typed code, empties the field before the request and says it is done', async () => {
    const user = userEvent.setup()
    const w = world()
    let fieldAtSend: string | undefined
    w.onRequest = (sent) => {
      if (sent.path.endsWith('/confirm')) {
        fieldAtSend = (document.getElementById('step-up-code') as HTMLInputElement).value
      }
    }
    await open(w)
    await user.type(await screen.findByLabelText('Code from the terminal'), 'ABCD-EFGH')
    await user.click(screen.getByRole('button', { name: 'Confirm command' }))
    expect(await screen.findByText(/^Confirmed\. Return to the terminal/)).toHaveAttribute(
      'id',
      'step-up-done',
    )
    expect(screen.getByText(/until 2026-10-13 08:12 UTC/)).toBeInTheDocument()
    expect(fieldAtSend).toBe('')
    expect(w.posts('/confirm')).toHaveLength(1)
    expect(w.posts('/confirm')[0]).toMatchObject({
      path: `/api/v1/step-ups/${STEP_UP}/confirm`,
      body: { userCode: 'ABCD-EFGH' },
    })
  })

  it('sends nothing for an empty code', async () => {
    const user = userEvent.setup()
    const w = world()
    await open(w)
    await user.click(await screen.findByRole('button', { name: 'Confirm command' }))
    expect(
      await screen.findByText('Enter the code your terminal shows. Nothing was sent.'),
    ).toBeInTheDocument()
    expect(w.posts('/confirm')).toEqual([])
  })

  it('asks for a fresh proof and confirms once more with the same code', async () => {
    const user = userEvent.setup()
    const w = world()
    w.reauthNeeded = true
    await open(w)
    await user.type(await screen.findByLabelText('Code from the terminal'), 'ABCD-EFGH')
    await user.click(screen.getByRole('button', { name: 'Confirm command' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.type(
      within(reauth).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
    expect(await screen.findByText(/^Confirmed\./)).toBeInTheDocument()
    expect(w.posts('/confirm').map((s) => s.body)).toEqual([
      { userCode: 'ABCD-EFGH' },
      { userCode: 'ABCD-EFGH' },
    ])
  })

  it('shows a refused code with the catalog text and its code, and keeps no code in the field', async () => {
    const user = userEvent.setup()
    const w = world()
    await open(w)
    const field = await screen.findByLabelText('Code from the terminal')
    await user.type(field, 'ZZZZ-ZZZZ')
    await user.click(screen.getByRole('button', { name: 'Confirm command' }))
    expect(
      await screen.findByText('The code does not match. (STEP_UP_CODE_INVALID)'),
    ).toBeInTheDocument()
    expect(field).toHaveValue('')
    expect(document.getElementById('step-up-done')).toBeNull()
  })

  it('cancels the command', async () => {
    const user = userEvent.setup()
    const w = world()
    await open(w)
    await user.click(await screen.findByRole('button', { name: 'Cancel command' }))
    expect(await screen.findByText('Canceled. The terminal command stops.')).toHaveAttribute(
      'id',
      'step-up-canceled',
    )
    expect(w.posts('/cancel')).toHaveLength(1)
  })

  it('says a step-up that is no longer pending is over', async () => {
    const w = world({ state: 'expired' })
    await open(w)
    expect(
      await screen.findByText(
        'This confirmation is expired. Start again from the terminal if needed.',
      ),
    ).toHaveAttribute('id', 'step-up-state')
    expect(screen.queryByLabelText('Code from the terminal')).toBeNull()
  })

  it('reads a step-up of anybody else as a failed read, never as a form', async () => {
    const w = new World()
    await open(w)
    expect(await screen.findByText('Could not read Confirmation request')).toBeInTheDocument()
    expect(screen.queryByLabelText('Code from the terminal')).toBeNull()
  })

  it('reloads the page when the fragment changes', async () => {
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => {})
    const w = world()
    await open(w)
    await screen.findByLabelText('Code from the terminal')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('has no accessibility violations', async () => {
    const w = world()
    await open(w)
    await screen.findByLabelText('Code from the terminal')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
