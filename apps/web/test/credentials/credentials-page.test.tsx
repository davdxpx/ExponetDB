import '@testing-library/jest-dom/vitest'
import type { CredentialView } from '@exponetdb/sdk/operations'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { pageReload } from '../../src/features/approvals/fragment-binding.ts'
import { CLUSTER, IDENTITY, mountApp, World } from '../plans/support.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PASSWORD = 'tangerine fjord radiator 42'

function credential(over: Partial<CredentialView> = {}): CredentialView {
  return {
    id: 'crd_01M4S9000000000000000000AK',
    clusterId: CLUSTER,
    accessRole: 'reader',
    roleName: 'exdb_reader',
    version: 1,
    state: 'active',
    failureCode: null,
    submittedAt: '2026-10-12T08:00:00.000Z',
    submittedBy: IDENTITY,
    stateChangedAt: '2026-10-12T08:01:00.000Z',
    verifiedAt: '2026-10-12T08:01:00.000Z',
    ...over,
  }
}

function world(items: CredentialView[] = []): World {
  const w = new World()
  w.credentials.set(CLUSTER, items)
  return w
}

async function open(w: World, fragment = `#cluster=${CLUSTER}&role=reader`) {
  const mounted = mountApp(`/credentials${fragment}`, w)
  await screen.findByRole('heading', { level: 1, name: 'Enter a role password' })
  return mounted
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement

describe('the credentials hand-off', () => {
  it('asks for the link the terminal shows unless the fragment is exactly a cluster and a role', async () => {
    for (const fragment of [
      '',
      '#cluster=cls_x',
      `#cluster=${CLUSTER}&role=superuser`,
      `#cluster=${CLUSTER}&role=reader&password=x`,
      `#cluster=${CLUSTER}&role=READER`,
      `#role=reader&cluster=${CLUSTER}`,
      `#cluster=${CLUSTER.toLowerCase()}`,
      '#cluster=../../account',
    ]) {
      const w = world()
      await open(w, fragment)
      expect(
        await screen.findByText('Open the link your terminal shows.'),
        fragment,
      ).toHaveAttribute('id', 'credentials-missing')
      expect(w.gets('/credentials'), fragment).toEqual([])
      cleanup()
    }
  })

  it('shows the cluster, the role from the link and the state of its latest password', async () => {
    const user = userEvent.setup()
    const w = world([
      credential(),
      credential({ version: 2, state: 'failed', failureCode: 'LOGIN_FAILED', verifiedAt: null }),
      credential({ accessRole: 'observer', roleName: 'exdb_observer', version: 4 }),
    ])
    await open(w)
    expect(document.getElementById('credential-cluster')).toHaveTextContent(CLUSTER)
    expect(document.getElementById('credential-role')).toHaveTextContent('reader')
    expect(await screen.findByText(/^Version 2 failed \(LOGIN_FAILED\)/)).toHaveAttribute(
      'id',
      'credential-state',
    )
    await user.click(screen.getByRole('combobox', { name: 'Role' }))
    await user.click(await screen.findByRole('option', { name: 'observer' }))
    expect(document.getElementById('credential-state')).toHaveTextContent(
      'Version 4 is active, 2026-10-12 08:01 UTC.',
    )
    await user.click(screen.getByRole('combobox', { name: 'Role' }))
    await user.click(await screen.findByRole('option', { name: 'migrator' }))
    expect(document.getElementById('credential-state')).toHaveTextContent(
      'No password was handed over for this role yet.',
    )
  })

  it('takes the password write-only: two fields, new-password, at least 16 characters', async () => {
    await open(world())
    for (const id of ['credential-password', 'credential-confirm']) {
      expect(field(id)).toHaveAttribute('type', 'password')
      expect(field(id)).toHaveAttribute('autocomplete', 'new-password')
      expect(field(id)).toHaveAttribute('minlength', '16')
    }
    expect(screen.getByLabelText('Password')).toBe(field('credential-password'))
    expect(screen.getByLabelText('Repeat the password')).toBe(field('credential-confirm'))
    expect(document.getElementById('credential-submit')).toHaveTextContent('Save password')
  })

  it('sends nothing when the two passwords differ, and empties both fields', async () => {
    const user = userEvent.setup()
    const w = world()
    await open(w)
    await user.type(field('credential-password'), PASSWORD)
    await user.type(field('credential-confirm'), `${PASSWORD}!`)
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The two passwords differ. Nothing was sent.',
    )
    expect(field('credential-password')).toHaveValue('')
    expect(field('credential-confirm')).toHaveValue('')
    expect(w.posts('/credentials/')).toEqual([])
  })

  it('sends nothing for a password shorter than 16 characters, and empties both fields', async () => {
    const user = userEvent.setup()
    const w = world()
    await open(w)
    await user.type(field('credential-password'), 'short password')
    await user.type(field('credential-confirm'), 'short password')
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The password has fewer than 16 characters. Nothing was sent.',
    )
    expect(field('credential-password')).toHaveValue('')
    expect(field('credential-confirm')).toHaveValue('')
    expect(w.posts('/credentials/')).toEqual([])
  })

  it('empties both fields before the request is sent and never shows or keeps the password', async () => {
    const user = userEvent.setup()
    const w = world([credential()])
    const atSend: string[] = []
    w.onRequest = (sent) => {
      if (sent.method === 'POST' && sent.path.includes('/credentials/')) {
        atSend.push(field('credential-password').value, field('credential-confirm').value)
      }
    }
    const { queryClient } = await open(w)
    await user.type(field('credential-password'), PASSWORD)
    await user.type(field('credential-confirm'), PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(await screen.findByText(/^Submitted version 2 of the reader password/)).toHaveClass(
      'status',
    )
    expect(atSend).toEqual(['', ''])
    expect(w.posts('/credentials/')).toEqual([
      expect.objectContaining({
        path: `/api/v1/clusters/${CLUSTER}/credentials/reader`,
        body: { password: PASSWORD },
      }),
    ])
    expect(document.body.innerHTML).not.toContain(PASSWORD)
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(PASSWORD)
    expect(document.getElementById('credential-state')).toHaveTextContent(/^Version 2 is pending/)
  })

  it('asks for a fresh proof and sends the same password once more, with the fields still empty', async () => {
    const user = userEvent.setup()
    const w = world()
    w.reauthNeeded = true
    await open(w)
    await user.type(field('credential-password'), PASSWORD)
    await user.type(field('credential-confirm'), PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    expect(field('credential-password')).toHaveValue('')
    await user.type(
      within(reauth).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
    expect(await screen.findByText(/^Submitted version 2/)).toBeInTheDocument()
    expect(w.posts('/credentials/').map((s) => s.body)).toEqual([
      { password: PASSWORD },
      { password: PASSWORD },
    ])
  })

  it('says "Canceled. Nothing was changed." when the proof is canceled', async () => {
    const user = userEvent.setup()
    const w = world()
    w.reauthNeeded = true
    await open(w)
    await user.type(field('credential-password'), PASSWORD)
    await user.type(field('credential-confirm'), PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.click(within(reauth).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Canceled. Nothing was changed.')
    expect(w.posts('/credentials/')).toHaveLength(1)
  })

  it('says a failed read of the passwords is not an empty one', async () => {
    const w = new World()
    w.failures.set('GET /api/v1/clusters', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'You may not read this cluster.',
    })
    await open(w)
    expect(
      await screen.findByText(
        'Could not read the passwords of this cluster: You may not read this cluster. (PERMISSION_DENIED) This does not mean none was handed over.',
      ),
    ).toHaveAttribute('id', 'credential-state')
  })

  it('does not call a role without a listed password new when the list is cut', async () => {
    const w = world([credential({ accessRole: 'observer' })])
    w.credentialsTruncated = true
    await open(w)
    await waitFor(() =>
      expect(document.getElementById('credential-state')).toHaveTextContent(
        'The list of passwords is longer than one read returns, so the state of this role is not known.',
      ),
    )
  })

  it('reloads the page when the fragment changes', async () => {
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => {})
    await open(world())
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('has no accessibility violations', async () => {
    await open(world([credential()]))
    await screen.findByText(/^Version 1 is active/)
    expect(await axeViolations(document.body)).toEqual([])
  })
})
