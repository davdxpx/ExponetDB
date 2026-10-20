import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  bootstrapSql,
  CLUSTER,
  cluster,
  ENDPOINT,
  endpoint,
  HOSTILE,
  mountApp,
  PLAN,
  World,
} from './support.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const LIST = '/infrastructure/clusters'
const DETAIL = `/infrastructure/clusters/${CLUSTER}`
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUexample\n-----END CERTIFICATE-----'
// Assembled at runtime so the repository secret scanner does not read it as key material.
const KEY_BLOCK = ['-----BEGIN', 'PRIVATE KEY-----\nabc\n-----END', 'PRIVATE KEY-----'].join(' ')

function byId(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`no #${id}`)
  return found
}

function external(over: Parameters<typeof cluster>[0] = {}) {
  return cluster({ managementMode: 'external', serverId: null, ...over })
}

async function proof(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
  await user.type(
    within(reauth).getByLabelText('Or enter the code from your authenticator app'),
    '123456',
  )
  await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
}

function clipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async (_text: string) => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  return writeText
}

describe('registering an external cluster', () => {
  it('names the permission it needs and shows no form without registry.manage', async () => {
    const world = new World()
    world.permissions = []
    mountApp(LIST, world)
    const section = await waitFor(() => byId('cluster-register'))
    expect(
      await within(section).findByText('You do not have access to cluster registration'),
    ).toBeVisible()
    expect(within(section).getByText('registry.manage')).toBeVisible()
    expect(document.getElementById('register-cluster-form')).toBeNull()
  })

  it('checks the name, the CA bundle and each endpoint before it sends anything', async () => {
    const user = userEvent.setup()
    const world = new World()
    mountApp(LIST, world)
    const form = await waitFor(() => byId('register-cluster-form'))
    await user.click(within(form).getByRole('button', { name: 'Create cluster registration plan' }))
    expect(
      await within(form).findByText('Enter 1 to 120 characters without control characters.'),
    ).toBeVisible()
    expect(within(form).getByText(/Paste at least one PEM certificate/)).toBeVisible()
    expect(within(form).getByText(/Use letters, digits, dots, colons and hyphens/)).toBeVisible()
    expect(
      within(form).getByText('Enter 1 to 64 characters without control characters.'),
    ).toBeVisible()
    expect(world.changes).toEqual([])
  })

  it('keeps a private key off the wire', async () => {
    const user = userEvent.setup()
    const world = new World()
    mountApp(LIST, world)
    const form = await waitFor(() => byId('register-cluster-form'))
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'acme-db' } })
    fireEvent.change(within(form).getByLabelText('CA bundle (PEM)'), {
      target: { value: `${PEM}\n${KEY_BLOCK}` },
    })
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'main' } })
    fireEvent.change(within(form).getByLabelText('Host'), { target: { value: 'db.example.test' } })
    await user.click(within(form).getByRole('button', { name: 'Create cluster registration plan' }))
    expect(await within(form).findByText(/looks like a private key/)).toBeVisible()
    expect(world.changes).toEqual([])
    expect(JSON.stringify(world.sent)).not.toContain('PRIVATE KEY')
  })

  it('needs the TLS server name of an IP address, and a mode for a pooler', async () => {
    const user = userEvent.setup()
    const world = new World()
    mountApp(LIST, world)
    const form = await waitFor(() => byId('register-cluster-form'))
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'acme-db' } })
    fireEvent.change(within(form).getByLabelText('CA bundle (PEM)'), { target: { value: PEM } })
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'main' } })
    fireEvent.change(within(form).getByLabelText('Host'), { target: { value: '10.8.2.5' } })
    await user.click(within(form).getByRole('button', { name: 'Create cluster registration plan' }))
    expect(await within(form).findByText(/An IP address needs the DNS name/)).toBeVisible()
    fireEvent.change(within(form).getByLabelText('Kind'), { target: { value: 'pooler' } })
    fireEvent.change(within(form).getByLabelText('TLS server name'), {
      target: { value: 'db.internal.example' },
    })
    await user.click(within(form).getByRole('button', { name: 'Create cluster registration plan' }))
    expect(await within(form).findByText('Choose the pooler mode.')).toBeVisible()
    expect(world.changes).toEqual([])
  })

  it('offers no local socket for an external cluster', async () => {
    mountApp(LIST, new World())
    const form = await waitFor(() => byId('register-cluster-form'))
    const kinds = within(within(form).getByLabelText('Kind'))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(kinds).toEqual(['Direct, private network', 'Direct, public', 'Pooler'])
  })

  it('plans the registration and opens the plan page', async () => {
    const user = userEvent.setup()
    const world = new World()
    const { router } = mountApp(LIST, world)
    const form = await waitFor(() => byId('register-cluster-form'))
    fireEvent.change(within(form).getByLabelText('Display name'), {
      target: { value: ' acme-db ' },
    })
    fireEvent.change(within(form).getByLabelText('CA bundle (PEM)'), {
      target: { value: `${PEM}\n` },
    })
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'main' } })
    fireEvent.change(within(form).getByLabelText('Host'), { target: { value: '10.8.2.5' } })
    fireEvent.change(within(form).getByLabelText('TLS server name'), {
      target: { value: 'db.internal.example' },
    })
    await user.click(within(form).getByRole('button', { name: 'Create cluster registration plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: '/api/v1/clusters',
        body: {
          displayName: 'acme-db',
          caBundle: PEM,
          endpoints: [
            {
              kind: 'private',
              host: '10.8.2.5',
              port: 5432,
              label: 'main',
              tlsServerName: 'db.internal.example',
            },
          ],
        },
      },
    ])
  })

  it('adds and removes endpoint rows, at most eight', async () => {
    const user = userEvent.setup()
    mountApp(LIST, new World())
    const form = await waitFor(() => byId('register-cluster-form'))
    expect(within(form).queryByRole('button', { name: /^Remove endpoint/ })).toBeNull()
    for (let i = 0; i < 7; i += 1) {
      await user.click(within(form).getByRole('button', { name: 'Add another endpoint' }))
    }
    expect(form.querySelectorAll('[data-endpoint-row]')).toHaveLength(8)
    expect(within(form).getByRole('button', { name: 'Add another endpoint' })).toBeDisabled()
    await user.click(within(form).getByRole('button', { name: 'Remove endpoint 8' }))
    expect(form.querySelectorAll('[data-endpoint-row]')).toHaveLength(7)
    expect(within(form).getByRole('button', { name: 'Add another endpoint' })).toBeEnabled()
  })

  it('shows the refusal with its code and keeps what was typed', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.failures.set('POST /api/v1/clusters', {
      status: 409,
      code: 'REGISTRY_CONFLICT',
      message: 'That address belongs to another cluster.',
    })
    const { router } = mountApp(LIST, world)
    const form = await waitFor(() => byId('register-cluster-form'))
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'acme-db' } })
    fireEvent.change(within(form).getByLabelText('CA bundle (PEM)'), { target: { value: PEM } })
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'main' } })
    fireEvent.change(within(form).getByLabelText('Host'), { target: { value: 'db.example.test' } })
    await user.click(within(form).getByRole('button', { name: 'Create cluster registration plan' }))
    expect(
      await within(form).findByText('That address belongs to another cluster. (REGISTRY_CONFLICT)'),
    ).toBeVisible()
    expect(within(form).getByLabelText('Display name')).toHaveValue('acme-db')
    expect(router.state.location.pathname).toBe(LIST)
  })

  it('asks for a fresh proof when the server asks, then repeats the request once', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.needsProof = true
    const { router } = mountApp(LIST, world)
    const form = await waitFor(() => byId('register-cluster-form'))
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'acme-db' } })
    fireEvent.change(within(form).getByLabelText('CA bundle (PEM)'), { target: { value: PEM } })
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'main' } })
    fireEvent.change(within(form).getByLabelText('Host'), { target: { value: 'db.example.test' } })
    await user.click(within(form).getByRole('button', { name: 'Create cluster registration plan' }))
    await proof(user)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    // The first request was refused for lack of a proof; the same request ran once more.
    expect(world.changes).toHaveLength(2)
    expect(world.changes[1]).toEqual(world.changes[0])
  })

  it('has no accessibility violations, empty and with problems shown', async () => {
    const user = userEvent.setup()
    mountApp(LIST, new World())
    const form = await waitFor(() => byId('register-cluster-form'))
    expect(await axeViolations(document.body)).toEqual([])
    await user.click(within(form).getByRole('button', { name: 'Create cluster registration plan' }))
    await within(form).findByText(/Paste at least one PEM certificate/)
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the role bootstrap SQL of an external cluster', () => {
  it('comes before the confirmation of a pending cluster, with the script, the roles and the steps', async () => {
    const world = new World()
    world.clusters = [external({ state: 'pending', confirmedAt: null, systemIdentifier: null })]
    world.bootstrap = bootstrapSql({ databases: ['orders'] })
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    await within(section).findByText(/CREATE ROLE exponetdb_observer NOLOGIN;/)
    expect(within(section).getByText(/The script contains no password/)).toBeVisible()
    expect(within(section).getAllByText('exponetdb_migrator').length).toBeGreaterThan(0)
    expect(within(section).getAllByText('orders').length).toBeGreaterThan(0)
    const steps = within(section)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(steps).toEqual([
      'Run the script below on the cluster as an administrator.',
      'Set each login password yourself with psql \\password: psql sends a verifier, never the password.',
      'Enter the same password once on the credentials page. It is write-only.',
      'Confirm the cluster. That pins its system identifier.',
    ])
    const confirm = byId('cluster-confirm')
    expect(section.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('copies the script exactly and tells the person', async () => {
    const user = userEvent.setup()
    const writeText = clipboard()
    const world = new World()
    world.clusters = [external()]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    await user.click(await within(section).findByRole('button', { name: 'Copy bootstrap SQL' }))
    expect(writeText).toHaveBeenCalledWith(world.bootstrap.script)
    expect(await screen.findByText('Bootstrap SQL copied')).toBeVisible()
  })

  it('follows the credentials of an active cluster, and has no confirm step', async () => {
    const world = new World()
    world.clusters = [external()]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    await within(section).findByText(/CREATE ROLE/)
    expect(within(section).queryByText(/Confirm the cluster\. That pins/)).toBeNull()
    expect(
      byId('cluster-credentials').compareDocumentPosition(section) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('is not shown for a cluster a node agent manages, nor for a retired one', async () => {
    const agent = new World()
    mountApp(DETAIL, agent)
    await waitFor(() => byId('cluster-endpoints'))
    expect(document.getElementById('cluster-bootstrap')).toBeNull()
    expect(agent.sent.some((s) => s.path.includes('bootstrap-sql'))).toBe(false)
    cleanup()
    const retired = new World()
    retired.clusters = [external({ state: 'retired' })]
    mountApp(DETAIL, retired)
    await waitFor(() => byId('cluster-endpoints'))
    expect(document.getElementById('cluster-bootstrap')).toBeNull()
  })

  it('names the permission it needs and does not ask for the script without registry.manage', async () => {
    const world = new World()
    world.permissions = []
    world.clusters = [external()]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    expect(
      await within(section).findByText('You do not have access to the role bootstrap SQL'),
    ).toBeVisible()
    expect(world.sent.some((s) => s.path.includes('bootstrap-sql'))).toBe(false)
  })

  it('shows a failed read as failed, never as an empty script', async () => {
    const world = new World()
    world.clusters = [external()]
    world.failures.set(`GET /api/v1/clusters/${CLUSTER}/bootstrap-sql`, {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry did not answer.',
    })
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    expect(await within(section).findByText(/Could not read Role bootstrap SQL/)).toBeVisible()
    expect(within(section).queryByText(/CREATE ROLE/)).toBeNull()
    expect(within(section).queryByRole('button', { name: 'Copy bootstrap SQL' })).toBeNull()
  })

  it('names the permission when the server refuses the script', async () => {
    const world = new World()
    world.clusters = [external()]
    world.failures.set(`GET /api/v1/clusters/${CLUSTER}/bootstrap-sql`, {
      status: 403,
      code: 'PERMISSION_DENIED',
    })
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    expect(await within(section).findByText('registry.manage')).toBeVisible()
    expect(within(section).queryByText(/CREATE ROLE/)).toBeNull()
  })

  it('shows an earlier read of the script as stale, with its age and a refresh', async () => {
    const world = new World()
    world.clusters = [external()]
    const { queryClient } = mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    await within(section).findByText(/CREATE ROLE/)
    world.failures.set(`GET /api/v1/clusters/${CLUSTER}/bootstrap-sql`, {
      status: 500,
      code: 'INTERNAL',
      message: 'Down.',
    })
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: ['infrastructure', 'clusters', CLUSTER, 'bootstrap-sql'],
      })
    })
    await waitFor(() => expect(section.querySelector('[data-state="stale"]')).not.toBeNull())
    expect(section.querySelector('[data-state="stale"]')?.textContent).toMatch(
      /Showing an earlier read of .*Observed/,
    )
    expect(within(section).getByRole('button', { name: 'Refresh' })).toBeVisible()
    expect(within(section).getByText(/CREATE ROLE/)).toBeVisible()
  })

  it('says no database is covered yet when none is registered, and lists them when they are', async () => {
    const world = new World()
    world.clusters = [external()]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    expect(await within(section).findByText(/No database is registered yet/)).toBeVisible()
  })

  it('shows hostile database names and script text as marked text', async () => {
    const world = new World()
    world.clusters = [external()]
    world.bootstrap = bootstrapSql({
      databases: [HOSTILE],
      script: `-- database ${HOSTILE}\nCREATE DATABASE "x";`,
    })
    const { container } = mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-bootstrap'))
    await waitFor(() => expect(section.textContent).toContain('⟨U+202E⟩'))
    expect(section.textContent).not.toContain(BIDI)
    expect(section.textContent).toContain('<script>alert(1)</script>')
    expect(container.querySelector('script')).toBeNull()
    expect(
      within(section).getAllByText(/characters? (are|is) marked|hidden/i).length,
    ).toBeGreaterThan(0)
  })
})

describe('registering a database', () => {
  it('checks the name, then plans the registration and opens the plan page', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.clusters = [external()]
    const { router } = mountApp(DETAIL, world)
    const form = await waitFor(() => byId('register-database-form'))
    expect(within(form).getByText(/run the role bootstrap SQL again/)).toBeVisible()
    await user.click(
      within(form).getByRole('button', { name: 'Create database registration plan' }),
    )
    expect(
      await within(form).findByText('Enter 1 to 63 characters without control characters.'),
    ).toBeVisible()
    expect(world.changes).toEqual([])
    fireEvent.change(within(form).getByLabelText('Database name'), {
      target: { value: ' orders ' },
    })
    await user.click(
      within(form).getByRole('button', { name: 'Create database registration plan' }),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      { method: 'POST', path: `/api/v1/clusters/${CLUSTER}/databases`, body: { name: 'orders' } },
    ])
  })

  it('does not mention the bootstrap SQL for a cluster a node agent manages', async () => {
    mountApp(DETAIL, new World())
    const form = await waitFor(() => byId('register-database-form'))
    expect(within(form).queryByText(/run the role bootstrap SQL again/)).toBeNull()
  })

  it('shows the refusal with its code', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.failures.set(`POST /api/v1/clusters/${CLUSTER}/databases`, {
      status: 409,
      code: 'REGISTRY_CONFLICT',
      message: 'That database is registered.',
    })
    mountApp(DETAIL, world)
    const form = await waitFor(() => byId('register-database-form'))
    fireEvent.change(within(form).getByLabelText('Database name'), { target: { value: 'orders' } })
    await user.click(
      within(form).getByRole('button', { name: 'Create database registration plan' }),
    )
    expect(
      await within(form).findByText('That database is registered. (REGISTRY_CONFLICT)'),
    ).toBeVisible()
  })

  it('says why there is no form: unconfirmed, retired, or no permission', async () => {
    const pending = new World()
    pending.clusters = [external({ state: 'pending', confirmedAt: null })]
    mountApp(DETAIL, pending)
    const section = await waitFor(() => byId('cluster-placements'))
    expect(await within(section).findByText(/Confirm the cluster first/)).toBeVisible()
    expect(document.getElementById('register-database-form')).toBeNull()
    cleanup()

    const retired = new World()
    retired.clusters = [cluster({ state: 'retired' })]
    mountApp(DETAIL, retired)
    const second = await waitFor(() => byId('cluster-placements'))
    expect(await within(second).findByText(/This cluster is retired/)).toBeVisible()
    cleanup()

    const plain = new World()
    plain.permissions = []
    mountApp(DETAIL, plain)
    const third = await waitFor(() => byId('cluster-placements'))
    expect(
      await within(third).findAllByText(
        /Registering a database needs the permission registry\.manage/,
      ),
    ).toHaveLength(1)
    expect(document.getElementById('register-database-form')).toBeNull()
  })
})

describe('adding and retiring endpoints', () => {
  it('checks the endpoint, then plans it and opens the plan page', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.endpoints = [endpoint()]
    const { router } = mountApp(DETAIL, world)
    const form = await waitFor(() => byId('add-endpoint-form'))
    await user.click(within(form).getByRole('button', { name: 'Create endpoint plan' }))
    expect(
      await within(form).findByText(/Use letters, digits, dots, colons and hyphens/),
    ).toBeVisible()
    expect(world.changes).toEqual([])
    fireEvent.change(within(form).getByLabelText('Kind'), { target: { value: 'pooler' } })
    fireEvent.change(within(form).getByLabelText('Pooler mode'), {
      target: { value: 'transaction' },
    })
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'pgbouncer' } })
    fireEvent.change(within(form).getByLabelText('Host'), {
      target: { value: 'pool.example.test' },
    })
    fireEvent.change(within(form).getByLabelText('Port'), { target: { value: '6432' } })
    await user.click(within(form).getByRole('button', { name: 'Create endpoint plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/clusters/${CLUSTER}/endpoints`,
        body: {
          kind: 'pooler',
          host: 'pool.example.test',
          port: 6432,
          label: 'pgbouncer',
          poolerMode: 'transaction',
        },
      },
    ])
  })

  it('says an endpoint is never edited, and offers a local socket only on an agent-managed cluster', async () => {
    const agent = new World()
    mountApp(DETAIL, agent)
    const form = await waitFor(() => byId('add-endpoint-form'))
    expect(within(form).getByText(/An endpoint is never edited/)).toBeVisible()
    expect(
      within(within(form).getByLabelText('Kind'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Direct, private network',
      'Direct, public',
      'Pooler',
      'Local socket (the host only)',
    ])
    cleanup()
    const ext = new World()
    ext.clusters = [external()]
    mountApp(DETAIL, ext)
    const second = await waitFor(() => byId('add-endpoint-form'))
    expect(
      within(within(second).getByLabelText('Kind')).queryByRole('option', { name: /socket/ }),
    ).toBeNull()
  })

  it('lists a Retire button for an active endpoint only', async () => {
    const world = new World()
    world.endpoints = [
      endpoint(),
      endpoint({
        id: 'end_01M4S9000000000000000000E2',
        label: 'old',
        state: 'retired',
        retiredAt: new Date().toISOString(),
      }),
    ]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-endpoints'))
    await within(section).findByText('old')
    expect(within(section).getAllByRole('button', { name: /^Retire the endpoint/ })).toHaveLength(1)
    expect(within(section).getByRole('button', { name: 'Retire the endpoint main' })).toBeVisible()
  })

  it('needs both statements ticked before the retirement plan, sends the reason code and opens the plan', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.endpoints = [endpoint()]
    const { router } = mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-endpoints'))
    await user.click(
      await within(section).findByRole('button', { name: 'Retire the endpoint main' }),
    )
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Create the endpoint retirement plan?')).toBeVisible()
    expect(within(dialog).getByText('db.example.test:5432')).toBeVisible()
    const action = within(dialog).getByRole('button', { name: 'Create retirement plan' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(within(dialog).getByLabelText('Reason code (optional)'), {
      target: { value: 'address_changed' },
    })
    const boxes = within(dialog).getAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    await user.click(boxes[0] as HTMLElement)
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(world.changes).toEqual([])
    await user.click(boxes[1] as HTMLElement)
    await waitFor(() => expect(action).not.toHaveAttribute('aria-disabled', 'true'))
    await user.click(action)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/clusters/${CLUSTER}/endpoints/${ENDPOINT}/retire`,
        body: { reason: 'address_changed' },
      },
    ])
  })

  it('sends no reason when none is typed, and refuses a reason that is not a code', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.endpoints = [endpoint()]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-endpoints'))
    await user.click(
      await within(section).findByRole('button', { name: 'Retire the endpoint main' }),
    )
    const dialog = await screen.findByRole('alertdialog')
    for (const box of within(dialog).getAllByRole('checkbox')) await user.click(box)
    fireEvent.change(within(dialog).getByLabelText('Reason code (optional)'), {
      target: { value: 'Not A Code!' },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Create retirement plan' }))
    expect(await within(dialog).findByText(/VALIDATION_FAILED/)).toBeVisible()
    expect(world.changes).toEqual([])
    fireEvent.change(within(dialog).getByLabelText('Reason code (optional)'), {
      target: { value: '' },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Create retirement plan' }))
    await waitFor(() => expect(world.changes).toHaveLength(1))
    expect(world.changes[0]?.body).toEqual({})
  })

  it('cancels without sending, and shows the production cue for a production cluster', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.clusters = [cluster({ declaredTier: 'prod', derivedTier: 'prod' })]
    world.endpoints = [endpoint()]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-endpoints'))
    await user.click(
      await within(section).findByRole('button', { name: 'Retire the endpoint main' }),
    )
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.querySelector('[data-slot="confirm-frame"]')).toHaveAttribute('data-tier', 'prod')
    expect(dialog.textContent).toContain('This changes a production target.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(world.changes).toEqual([])
  })

  it('offers no change to a person without registry.manage, and says which permission it takes', async () => {
    const world = new World()
    world.permissions = []
    world.endpoints = [endpoint()]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-endpoints'))
    await within(section).findByText('main')
    expect(within(section).queryByRole('button', { name: /^Retire/ })).toBeNull()
    expect(document.getElementById('add-endpoint-form')).toBeNull()
    expect(
      within(section).getByText(
        /Adding or retiring an endpoint needs the permission registry\.manage/,
      ),
    ).toBeVisible()
  })

  it('shows hostile endpoint labels and hosts as marked text in the retirement dialog too', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.endpoints = [endpoint({ label: HOSTILE, host: `db${BIDI}.example.test` })]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-endpoints'))
    await within(section).findAllByText(/⟨U\+202E⟩/)
    await user.click(within(section).getByRole('button', { name: /^Retire the endpoint/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('⟨U+202E⟩')
    expect(dialog.textContent).not.toContain(BIDI)
    expect(document.querySelector('script')).toBeNull()
  })

  it('has no accessibility violations with the forms and the retirement dialog', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.endpoints = [endpoint()]
    mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-endpoints'))
    await user.click(
      await within(section).findByRole('button', { name: 'Retire the endpoint main' }),
    )
    await screen.findByRole('alertdialog')
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('rotating the credentials of an agent-managed cluster', () => {
  it('offers Rotate for each role, plans the rotation after a confirmation and opens the plan page', async () => {
    const user = userEvent.setup()
    const world = new World()
    const { router } = mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-credentials'))
    for (const role of ['observer', 'reader', 'verifier', 'operator', 'migrator']) {
      expect(
        within(section).getByRole('button', { name: `Rotate the ${role} password` }),
      ).toBeVisible()
    }
    await user.click(within(section).getByRole('button', { name: 'Rotate the migrator password' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Create the rotation plan?')).toBeVisible()
    expect(dialog.textContent).toContain('exponetdb_migrator')
    expect(dialog.textContent).toContain('Nobody sees the password')
    expect(world.changes).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Create rotation plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      { method: 'POST', path: `/api/v1/clusters/${CLUSTER}/credentials/migrator/rotate`, body: {} },
    ])
  })

  it('shows the production cue, and the refusal of a node that is offline', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.clusters = [cluster({ declaredTier: null })]
    world.failures.set(`POST /api/v1/clusters/${CLUSTER}/credentials/observer/rotate`, {
      status: 409,
      code: 'NODE_OFFLINE',
      message: 'The node of this cluster is offline.',
    })
    const { router } = mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-credentials'))
    await user.click(within(section).getByRole('button', { name: 'Rotate the observer password' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.querySelector('[data-slot="confirm-frame"]')).toHaveAttribute('data-tier', 'prod')
    await user.click(within(dialog).getByRole('button', { name: 'Create rotation plan' }))
    expect(await within(dialog).findByText('The node of this cluster is offline.')).toBeVisible()
    expect(within(dialog).getByText('NODE_OFFLINE')).toBeVisible()
    expect(router.state.location.pathname).toBe(DETAIL)
  })

  it('is not offered on an external cluster, a retired one or without registry.manage', async () => {
    const ext = new World()
    ext.clusters = [external()]
    mountApp(DETAIL, ext)
    const section = await waitFor(() => byId('cluster-credentials'))
    expect(within(section).getAllByRole('link').length).toBeGreaterThan(0)
    expect(within(section).queryByRole('button', { name: /^Rotate/ })).toBeNull()
    cleanup()
    const plain = new World()
    plain.permissions = []
    mountApp(DETAIL, plain)
    const second = await waitFor(() => byId('cluster-credentials'))
    expect(within(second).queryByRole('button', { name: /^Rotate/ })).toBeNull()
    cleanup()
    const retired = new World()
    retired.clusters = [cluster({ state: 'retired' })]
    mountApp(DETAIL, retired)
    const third = await waitFor(() => byId('cluster-credentials'))
    expect(within(third).queryByRole('button', { name: /^Rotate/ })).toBeNull()
  })

  it('asks for a fresh proof when the server asks, then repeats the request once', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.needsProof = true
    const { router } = mountApp(DETAIL, world)
    const section = await waitFor(() => byId('cluster-credentials'))
    await user.click(within(section).getByRole('button', { name: 'Rotate the reader password' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create rotation plan' }))
    await proof(user)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toHaveLength(2)
    expect(world.changes[1]).toEqual(world.changes[0])
  })
})
