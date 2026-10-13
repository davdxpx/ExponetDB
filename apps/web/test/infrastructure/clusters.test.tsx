import '@testing-library/jest-dom/vitest'
import { isScramSha256Verifier } from '@exponetdb/contracts'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { infraKeys } from '../../src/features/infrastructure/keys.ts'
import {
  BIDI,
  CLUSTER,
  cluster,
  HOSTILE,
  mountApp,
  NODE,
  PLAN,
  TAG,
  TARGET,
  World,
} from './support.tsx'

afterEach(cleanup)

const DETAIL = `/infrastructure/clusters/${CLUSTER}`
// Assembled at runtime so the repository secret scanner does not read it as a credential.
const PASSWORD = ['a-long-consumer', 'password-42'].join('-')

function form(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`no #${id}`)
  return found
}

describe('the clusters page', () => {
  it('lists clusters with their declared tier, and an undeclared one as treated as production', async () => {
    const world = new World()
    world.clusters = [
      cluster(),
      cluster({
        id: 'cls_01M4S9000000000000000000C2',
        displayName: HOSTILE,
        declaredTier: null,
        health: null,
      }),
    ]
    const { container } = mountApp('/infrastructure/clusters', world)
    const table = await screen.findByRole('table', { name: 'Clusters' })
    expect(within(table).getByText('Undeclared, treated as production')).toBeInTheDocument()
    expect(table.textContent).toContain('<script>alert(1)</script>')
    expect(table.textContent).toContain('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
    expect(container.querySelector('script')).toBeNull()
    // A cluster without health is unknown, never healthy.
    const row = table.querySelector('[data-cluster="cls_01M4S9000000000000000000C2"]')
    expect(row?.querySelector('[data-health="healthy"]')).toBeNull()
    expect(row?.querySelector('[data-health="unknown"]')).not.toBeNull()
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows a failed read as failed, never as an empty list', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/clusters', { status: 500, code: 'INTERNAL', message: 'Boom.' })
    mountApp('/infrastructure/clusters', world)
    expect(await screen.findByText('Could not read Cluster list')).toBeInTheDocument()
    expect(screen.queryByText('No clusters yet')).toBeNull()
  })

  it('is empty only after a successful read', async () => {
    const world = new World()
    world.clusters = []
    mountApp('/infrastructure/clusters', world)
    expect(await screen.findByText('No clusters yet')).toBeInTheDocument()
    expect(screen.queryByText('Could not read Cluster list')).toBeNull()
  })

  it('shows an old read as stale with its age and a refresh', async () => {
    const world = new World()
    world.hang.add('GET /api/v1/clusters')
    mountApp('/infrastructure/clusters', world, (queryClient) =>
      queryClient.setQueryData(
        infraKeys.clusters(),
        { items: [cluster()], nextCursor: null },
        { updatedAt: Date.now() - 5 * 60_000 },
      ),
    )
    expect(await screen.findByText('Showing an earlier read of Cluster list')).toBeInTheDocument()
    expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
      /Observed [45] min ago/,
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Clusters' })).toBeInTheDocument()
  })

  it('says what is missing from a partial list and never shows it as empty', async () => {
    const world = new World()
    world.clusters = []
    world.clustersNextCursor = 'next'
    mountApp('/infrastructure/clusters', world)
    expect(await screen.findByText('Items after the first 200')).toBeInTheDocument()
    expect(screen.queryByText('No clusters yet')).toBeNull()
  })
})

describe('the cluster page', () => {
  it('shows placements with a link to the target, and passes axe', async () => {
    const world = new World()
    world.databases = [
      {
        id: 'dbs_01M4S9000000000000000000D1',
        clusterId: CLUSTER,
        name: `shop${TAG}`,
        state: 'registered',
        createdAt: '2026-10-01T00:00:00Z',
        observed: null,
        placement: { targetId: TARGET, generation: 3 },
      },
    ]
    world.targets = [
      {
        id: TARGET,
        path: 'shop/platform/staging',
        tier: 'nonprod',
        state: 'active',
        generation: 3,
        health: null,
        environmentId: 'env_01M4S9000000000000000000V1',
        productId: 'prd_01M4S9000000000000000000R1',
        projectId: 'prj_01M4S9000000000000000000J1',
      },
    ]
    const { container } = mountApp(DETAIL, world)
    expect(await screen.findByRole('link', { name: 'shop/platform/staging' })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging',
    )
    expect(screen.getByText('Generation 3')).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows an old read of the cluster as stale with its age and a refresh', async () => {
    const world = new World()
    world.hang.add(`GET /api/v1/clusters/${CLUSTER}`)
    mountApp(DETAIL, world, (queryClient) =>
      queryClient.setQueryData(infraKeys.cluster(CLUSTER), cluster(), {
        updatedAt: Date.now() - 5 * 60_000,
      }),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
        /Observed [45] min ago/,
      ),
    )
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0)
  })

  it('names what is missing when placements or endpoints are truncated, not an empty list', async () => {
    const world = new World()
    world.databasesTruncated = true
    world.endpointsTruncated = true
    mountApp(DETAIL, world)
    expect(await screen.findByText('Databases beyond the first page')).toBeInTheDocument()
    expect(await screen.findByText('Endpoints beyond the first page')).toBeInTheDocument()
  })

  it('names registry.manage when the endpoint addresses are refused', async () => {
    const world = new World()
    world.failures.set(`GET /api/v1/clusters/${CLUSTER}/endpoints`, {
      status: 403,
      code: 'PERMISSION_DENIED',
    })
    mountApp(DETAIL, world)
    const section = await waitFor(() => form('cluster-endpoints'))
    expect(await within(section).findByText(/registry\.manage/)).toBeInTheDocument()
    expect(within(section).queryByText('This cluster has no endpoint.')).toBeNull()
  })

  it('declares the tier as a plan and says it always needs production authority', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.clusters = [cluster({ declaredTier: null })]
    const { router, container } = mountApp(DETAIL, world)
    const tierForm = await waitFor(() => form('declare-tier-form'))
    expect(tierForm.textContent).toContain('Undeclared, treated as production')
    expect(tierForm.textContent).toContain('Needs production authority')
    expect(tierForm.textContent).toContain(
      'registry.manage at the production tier, whichever value you choose',
    )
    // Undeclared counts as production: the page carries the production frame.
    expect(container.querySelector('[data-production-frame]')).not.toBeNull()
    fireEvent.change(within(tierForm).getByLabelText('Declare the cluster as'), {
      target: { value: 'nonprod' },
    })
    await user.click(within(tierForm).getByRole('button', { name: 'Plan tier declaration' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/clusters/${CLUSTER}/declared-tier`,
        body: { declaredTier: 'nonprod' },
      },
    ])
  })

  it('needs the cluster name typed before granting BYPASSRLS, REPLICATION or CREATEROLE', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.clusters = [cluster({ displayName: `shop-main${BIDI}` })]
    const { router } = mountApp(DETAIL, world)
    const rolesForm = await waitFor(() => form('roles-form'))
    fireEvent.change(within(rolesForm).getByLabelText('Role name'), {
      target: { value: 'shop_service' },
    })
    fireEvent.change(within(rolesForm).getByLabelText('BYPASSRLS'), { target: { value: 'grant' } })
    await user.click(within(rolesForm).getByRole('button', { name: 'Plan role changes' }))

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Grant powerful role attributes?',
    })
    expect(dialog.textContent).toContain('Grants BYPASSRLS to')
    expect(dialog.textContent).toContain('shop_service')
    // The expected text shows the direction override as a code point.
    expect(dialog.textContent).toContain('shop-main⟨U+202E⟩')
    const action = within(dialog).getByRole('button', { name: 'Plan role changes' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    await user.click(action)
    expect(world.changes).toEqual([])

    const field = within(dialog).getByRole('textbox')
    fireEvent.change(field, { target: { value: 'shop-main' } })
    await user.click(action)
    expect(world.changes).toEqual([])

    fireEvent.change(field, { target: { value: `shop-main${BIDI}` } })
    await waitFor(() => expect(action).not.toHaveAttribute('aria-disabled', 'true'))
    await user.click(action)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toHaveLength(1)
    expect(world.changes[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/nodes/${NODE}/plans`,
      body: {
        clusterId: CLUSTER,
        change: {
          kind: 'postgres.roles.apply',
          steps: [
            {
              op: 'create_role',
              role: 'shop_service',
              attributes: { bypassrls: true, login: null },
              verifier: null,
            },
          ],
        },
      },
    })
  })

  it('plans role changes without a typed confirmation when nothing powerful is granted', async () => {
    const user = userEvent.setup()
    const world = new World()
    const { router } = mountApp(DETAIL, world)
    const rolesForm = await waitFor(() => form('roles-form'))
    fireEvent.change(within(rolesForm).getByLabelText('Role name'), {
      target: { value: 'shop_app' },
    })
    fireEvent.change(within(rolesForm).getByLabelText('LOGIN'), { target: { value: 'grant' } })
    fireEvent.change(within(rolesForm).getByLabelText('BYPASSRLS'), {
      target: { value: 'revoke' },
    })
    await user.click(within(rolesForm).getByRole('button', { name: 'Plan role changes' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(world.changes).toHaveLength(1)
  })

  it('sends only the role and a SCRAM verifier, never the password, and clears both fields', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.needsProof = true
    const { router, queryClient } = mountApp(DETAIL, world)
    const verifierForm = await waitFor(() => form('verifier-form'))
    const password = within(verifierForm).getByLabelText('New password') as HTMLInputElement
    const repeat = within(verifierForm).getByLabelText('Repeat the password') as HTMLInputElement
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autocomplete', 'new-password')
    fireEvent.change(within(verifierForm).getByLabelText('Login role'), {
      target: { value: 'shop_app' },
    })
    fireEvent.change(password, { target: { value: PASSWORD } })
    fireEvent.change(repeat, { target: { value: PASSWORD } })
    await user.click(within(verifierForm).getByRole('button', { name: 'Plan password change' }))
    expect(password.value).toBe('')
    expect(repeat.value).toBe('')

    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    fireEvent.change(
      within(reauth).getByLabelText('Or enter the code from your authenticator app'),
      { target: { value: '123456' } },
    )
    await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))

    const sent = world.changes.filter((s) => s.path.endsWith('/role-verifiers'))
    expect(sent).toHaveLength(2)
    for (const request of sent) {
      expect(request.path).toBe(`/api/v1/clusters/${CLUSTER}/role-verifiers`)
      const body = request.body as { role: string; verifier: string }
      expect(Object.keys(body).sort()).toEqual(['role', 'verifier'])
      expect(body.role).toBe('shop_app')
      expect(isScramSha256Verifier(body.verifier)).toBe(true)
      expect(body.verifier.startsWith('SCRAM-SHA-256$4096:')).toBe(true)
    }
    // Nothing the page sent or kept holds the password.
    expect(JSON.stringify(world.sent)).not.toContain(PASSWORD)
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state),
      ),
    ).not.toContain(PASSWORD)
    expect(document.body.innerHTML).not.toContain(PASSWORD)
  })

  it('sends nothing when the passwords differ or are short, and clears the fields', async () => {
    const user = userEvent.setup()
    const world = new World()
    mountApp(DETAIL, world)
    const verifierForm = await waitFor(() => form('verifier-form'))
    const password = within(verifierForm).getByLabelText('New password') as HTMLInputElement
    const repeat = within(verifierForm).getByLabelText('Repeat the password') as HTMLInputElement
    const role = within(verifierForm).getByLabelText('Login role')
    const submit = within(verifierForm).getByRole('button', { name: 'Plan password change' })
    fireEvent.change(role, { target: { value: 'shop_app' } })
    fireEvent.change(password, { target: { value: PASSWORD } })
    fireEvent.change(repeat, { target: { value: `${PASSWORD}x` } })
    await user.click(submit)
    expect(within(verifierForm).getByRole('alert')).toHaveTextContent('The passwords do not match.')
    expect(password.value).toBe('')
    expect(repeat.value).toBe('')

    fireEvent.change(password, { target: { value: 'short' } })
    fireEvent.change(repeat, { target: { value: 'short' } })
    await user.click(submit)
    expect(within(verifierForm).getByRole('alert')).toHaveTextContent('Use at least 16 characters.')

    fireEvent.change(role, { target: { value: 'exponetdb_reader' } })
    fireEvent.change(password, { target: { value: PASSWORD } })
    fireEvent.change(repeat, { target: { value: PASSWORD } })
    await user.click(submit)
    expect(within(verifierForm).getByRole('alert')).toHaveTextContent(/consumer role name/)
    expect(world.changes).toEqual([])
  })

  it("links the hand-off of ExponetDB's credentials to the credentials page", async () => {
    const world = new World()
    mountApp(DETAIL, world)
    const link = await screen.findByRole('link', { name: 'Set the reader password' })
    expect(link).toHaveAttribute('href', `/credentials#cluster=${CLUSTER}&role=reader`)
  })

  it('says the roles of an external cluster are not managed', async () => {
    const world = new World()
    world.clusters = [cluster({ managementMode: 'external', serverId: null })]
    mountApp(DETAIL, world)
    expect(
      await screen.findByText(/Roles of an external cluster are not managed by ExponetDB/),
    ).toBeInTheDocument()
    expect(document.getElementById('roles-form')).toBeNull()
  })

  it('reads the roles through the node on request', async () => {
    const user = userEvent.setup()
    const world = new World()
    mountApp(DETAIL, world)
    await user.click(await screen.findByRole('button', { name: 'Read roles now' }))
    await waitFor(() =>
      expect(world.changes).toEqual([
        {
          method: 'POST',
          path: `/api/v1/nodes/${NODE}/inspections`,
          body: {
            capability: 'postgres.roles.inspect@2',
            clusterId: CLUSTER,
            args: { expectSettings: [] },
          },
        },
      ]),
    )
  })
})
