import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { breakGlassList, dataReadRule, environment } from '../admin/fixtures.ts'
import {
  deferred,
  expectInert,
  HOSTILE,
  mountApp,
  PLAN,
  plan,
  problem,
  T0,
  TARGET,
  World,
} from '../admin/support.tsx'

afterEach(cleanup)

const PRODUCT = 'prd_01JZ0000000000000000000001'

function settingsWorld(): World {
  const world = new World()
  world.on('GET', '/api/v1/break-glass-grants', breakGlassList([]))
  world.on('GET', '/api/v1/products', {
    items: [{ id: PRODUCT, slug: 'shop', displayName: 'Shop' }],
    nextCursor: null,
  })
  world.on('GET', `/api/v1/products/${PRODUCT}/environments`, {
    items: [
      environment({
        id: 'env_01JZ0000000000000000000003',
        slug: 'production',
        displayName: 'Production',
        tier: 'prod',
        rank: 20,
        evidenceFrom: 'staging',
      }),
      environment({ evidenceFrom: 'development' }),
      environment({
        id: 'env_01JZ0000000000000000000002',
        slug: 'development',
        displayName: 'Development',
        rank: 0,
      }),
    ],
    nextCursor: null,
  })
  world.on('GET', '/api/v1/policy-settings', {
    rules: [
      dataReadRule({
        settings: [
          {
            createdAt: T0,
            operationId: null,
            params: { mode: 'humans_only' },
            revision: 1,
            scopeId: 'installation',
            scopeKind: 'installation',
          },
          {
            createdAt: T0,
            operationId: null,
            params: { mode: 'disabled' },
            revision: 1,
            scopeId: TARGET,
            scopeKind: 'target',
          },
        ],
      }),
      {
        appliesTo: ['plan.apply'],
        defaults: { allowed: false },
        description: HOSTILE,
        id: 'approval.self-approval',
        settings: [],
        severity: 'require',
        version: 1,
      },
    ],
  })
  world.on('GET', '/api/v1/targets', {
    items: [{ id: TARGET, path: 'shop/app/production', tier: 'prod' }],
    nextCursor: null,
  })
  world.on('GET', '/api/v1/installation', {
    contracts: {
      mcpCatalog: 'exponetdb.mcp/v1',
      migrationManifest: 'exponetdb.migration/v1',
      nodeProtocol: 'exponetdb.node/v1',
      projectConfig: 'exponetdb.project/v1',
      restApi: 'v1',
    },
    features: ['registry', 'approvals'],
    installationId: 'ins_01JZ0000000000000000000001',
    version: '0.8.0',
  })
  world.on('GET', '/api/v1/installation/health', {
    components: [
      {
        component: 'control_store',
        observedAt: new Date().toISOString(),
        source: 'live',
        state: 'operational',
      },
      {
        component: 'workers',
        observedAt: new Date().toISOString(),
        source: 'live',
        state: 'degraded',
        reasons: ['heartbeat_late'],
      },
    ],
    observedAt: new Date().toISOString(),
    state: 'degraded',
    unobserved: [{ component: 'gateway', reason: 'not_applicable' }],
  })
  return world
}

describe('the products and environments pages', () => {
  it('lists products, and a new product is a plan whose review page opens', async () => {
    const user = userEvent.setup()
    const world = settingsWorld()
    world.on('POST', '/api/v1/products', (request) => {
      expect(request.body).toEqual({ slug: 'acme', displayName: 'Acme' })
      return { status: 201, json: plan() }
    })
    const { container, router } = mountApp('/settings/products', world)
    await waitFor(() =>
      expect(document.querySelector(`[data-product="${PRODUCT}"]`)).not.toBeNull(),
    )
    expect(await axeViolations(container)).toEqual([])
    const form = document.getElementById('product-create') as HTMLElement
    fireEvent.change(within(form).getByLabelText('Slug'), { target: { value: 'Not A Slug' } })
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Acme' } })
    await user.click(within(form).getByRole('button', { name: 'Create plan to add product' }))
    expect(await within(form).findByText(/Use lower-case letters/)).toBeInTheDocument()
    expect(world.changes).toEqual([])
    fireEvent.change(within(form).getByLabelText('Slug'), { target: { value: 'acme' } })
    await user.click(within(form).getByRole('button', { name: 'Create plan to add product' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('shows loading, a failed read and partial products truthfully', async () => {
    const world = settingsWorld()
    const hold = deferred()
    world.on('GET', '/api/v1/products', async () => {
      await hold.promise
      return problem(503, 'CONTROL_PLANE_DEGRADED', 'Down.')
    })
    mountApp('/settings/products', world)
    expect(await screen.findByText('Loading Product list')).toBeInTheDocument()
    hold.resolve()
    expect(
      await screen.findByText('Could not read Product list', {}, { timeout: 10_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No products yet')).toBeNull()
    cleanup()

    const partial = settingsWorld()
    partial.on('GET', '/api/v1/products', {
      items: [{ id: PRODUCT, slug: 'shop', displayName: 'Shop' }],
      nextCursor: 'more',
    })
    mountApp('/settings/products', partial)
    expect(await screen.findByText('Showing part of Product list')).toBeInTheDocument()
  })

  it('shows tiers from the contract with the production chip, the evidence chain, and plans a change', async () => {
    const user = userEvent.setup()
    const world = settingsWorld()
    world.on(
      'POST',
      `/api/v1/products/${PRODUCT}/environments/env_01JZ0000000000000000000001/change-plans`,
      (request) => {
        expect(request.body).toEqual({ tier: 'prod' })
        return { status: 201, json: plan() }
      },
    )
    const { container, router } = mountApp('/settings/environments', world)
    const staging = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        'li[data-environment="env_01JZ0000000000000000000001"]',
      )
      if (found === null) throw new Error('no staging')
      return found
    })
    const production = document.querySelector(
      'li[data-environment="env_01JZ0000000000000000000003"]',
    )
    expect(production).toHaveAttribute('data-tier', 'prod')
    expect(production?.textContent).toContain('Production')
    expect(production?.textContent).toContain('Needs verified evidence from staging')
    expect(screen.getByText('development → staging → production')).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])

    await user.click(within(staging).getByRole('button', { name: 'Change' }))
    const form = within(staging).getByRole('form', { name: 'Change environment staging' })
    await user.click(
      within(form).getByRole('button', { name: 'Create plan to change environment' }),
    )
    expect(
      await within(form).findByText('Nothing was changed. Change a field first.'),
    ).toBeInTheDocument()
    await user.selectOptions(within(form).getByLabelText('Tier'), 'prod')
    expect(
      within(form).getByText(/Production: changes here need verified evidence/),
    ).toBeInTheDocument()
    await user.click(
      within(form).getByRole('button', { name: 'Create plan to change environment' }),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })
})

describe('the policies page', () => {
  it('shows who reads rows on each tier and the targets with their own setting', async () => {
    const world = settingsWorld()
    const { container } = mountApp('/settings/policies', world)
    const section = await waitFor(() => {
      const found = document.getElementById('data-read-policy')
      if (found === null) throw new Error('no data read section')
      return found
    })
    expect(section.textContent).toContain('At the installation: People only.')
    const tiers = document.getElementById('data-read-tiers')
    expect(tiers?.querySelector('[data-tier="prod"]')?.textContent).toContain('People only')
    expect(tiers?.querySelector('[data-tier="nonprod"]')?.textContent).toContain('People only')
    expect(section.textContent).toContain(TARGET)
    expect(section.textContent).toContain('Nobody')
    // Rule text from the server is shown as text.
    expect(document.querySelector('li[data-rule="approval.self-approval"]')?.textContent).toContain(
      '<script>',
    )
    expectInert(container)
    expect(await axeViolations(container)).toEqual([])
  })

  it('plans a data-read change for one production target and refuses a malformed column', async () => {
    const user = userEvent.setup()
    const world = settingsWorld()
    world.on('POST', '/api/v1/policy-settings/plans', (request) => {
      expect(request.body).toEqual({
        ruleId: 'data.read',
        scopeKind: 'target',
        scopeId: TARGET,
        params: { mode: 'humans_only', sensitiveColumns: ['public.users.email'] },
      })
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/settings/policies', world)
    const form = await waitFor(() => {
      const found = document.getElementById('data-read-form')
      if (found === null) throw new Error('no form')
      return found
    })
    await waitFor(() =>
      expect(within(form).getByLabelText('Applies to').querySelectorAll('option')).toHaveLength(2),
    )
    await user.selectOptions(within(form).getByLabelText('Applies to'), TARGET)
    expect(within(form).getByText('This target is production.')).toBeInTheDocument()
    expect((within(form).getByLabelText('Who reads rows') as HTMLSelectElement).value).toBe(
      'disabled',
    )
    await user.selectOptions(within(form).getByLabelText('Who reads rows'), 'humans_only')
    fireEvent.change(within(form).getByLabelText('Masked columns (one per line)'), {
      target: { value: 'users.email' },
    })
    await user.click(within(form).getByRole('button', { name: 'Create plan to change setting' }))
    expect(
      await within(form).findByText(/does not fit schema.table.column: users.email/),
    ).toBeInTheDocument()
    expect(world.changes).toEqual([])
    fireEvent.change(within(form).getByLabelText('Masked columns (one per line)'), {
      target: { value: 'public.users.email\n' },
    })
    await user.click(within(form).getByRole('button', { name: 'Create plan to change setting' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('shows every rule but the data-read rule as a closed row that names its state', async () => {
    const world = settingsWorld()
    world.on('GET', '/api/v1/policy-settings', {
      rules: [
        dataReadRule({ settings: [] }),
        {
          appliesTo: ['plan.apply'],
          defaults: { allowed: false },
          description: 'Self approval of a human-initiated plan.',
          id: 'approval.self-approval',
          settings: [],
          severity: 'require',
          version: 1,
        },
        {
          appliesTo: ['plan.create'],
          defaults: { minutes: 30 },
          description: 'How long a plan stays valid.',
          id: 'plan.ttl',
          settings: [
            {
              createdAt: T0,
              operationId: null,
              params: { minutes: 15 },
              revision: 3,
              scopeId: 'installation',
              scopeKind: 'installation',
            },
          ],
          severity: 'require',
          version: 2,
        },
      ],
    })
    const { container } = mountApp('/settings/policies', world)
    const changed = await waitFor(() => {
      const row = document.querySelector<HTMLElement>('li[data-rule="plan.ttl"]')
      if (row === null) throw new Error('no plan.ttl row')
      return row
    })
    const unchanged = document.querySelector<HTMLElement>('li[data-rule="approval.self-approval"]')
    expect(changed).toHaveAttribute('data-state', 'changed')
    expect(unchanged).toHaveAttribute('data-state', 'default')
    // The data-read rule keeps its own section and is not a row.
    expect(document.querySelector('li[data-rule="data.read"]')).toBeNull()
    for (const row of document.querySelectorAll('li[data-rule] > details')) {
      expect(row).not.toHaveAttribute('open')
    }
    const summary = changed.querySelector('summary') as HTMLElement
    expect(summary.textContent).toContain('plan.ttl')
    expect(summary.textContent).toContain('How long a plan stays valid.')
    expect(summary.textContent).toContain('Changed')
    expect(summary.textContent).toMatch(/2/)
    expect(unchanged?.querySelector('summary')?.textContent).not.toContain('Changed')
    fireEvent.click(summary)
    await waitFor(() => expect(changed.querySelector('details')).toHaveAttribute('open'))
    expect(changed.textContent).toContain('Revision 3')
    expect(await axeViolations(container)).toEqual([])
  })

  it('offers no change without policy.manage', async () => {
    const world = settingsWorld()
    world.permissions = ['access.read']
    mountApp('/settings/policies', world)
    await waitFor(() => expect(document.getElementById('data-read-policy')).not.toBeNull())
    expect(document.getElementById('data-read-form')).toBeNull()
    expect(
      screen.getByText(/Changing a setting needs the permission policy.manage/),
    ).toBeInTheDocument()
  })
})

describe('the installation, notifications pages', () => {
  it('lists every component with its state and source, and the unobserved ones as not observed', async () => {
    const { container } = mountApp('/settings/installation', settingsWorld())
    await waitFor(() => expect(document.getElementById('installation-components')).not.toBeNull())
    expect(document.querySelector('[data-component="workers"]')?.textContent).toContain(
      'heartbeat_late',
    )
    expect(document.querySelector('[data-unobserved="gateway"]')?.textContent).toBe(
      'gateway: not observed (not_applicable)',
    )
    expect(document.querySelector('[data-component="gateway"]')).toBeNull()
    expect(
      screen.getByText('Components not observed and not part of this state: 1.'),
    ).toBeInTheDocument()
    expect(screen.getByText('0.8.0')).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })

  it('names the missing permission when health is refused, never shows it as healthy', async () => {
    const world = settingsWorld()
    world.on('GET', '/api/v1/installation/health', () => problem(403, 'PERMISSION_DENIED', 'No.'))
    mountApp('/settings/installation', world)
    expect(
      await screen.findByText(/You do not have access to Control Plane health/),
    ).toBeInTheDocument()
    expect(screen.queryByText('Operational')).toBeNull()
  })

  it('shows notifications as the OD-21 named state, with no form or list', async () => {
    const { container } = mountApp('/settings/notifications', settingsWorld())
    expect(
      await screen.findByText('Notification channels is not available yet'),
    ).toBeInTheDocument()
    expect(screen.getByText(/OD-21/)).toBeInTheDocument()
    expect(container.querySelector('form')).toBeNull()
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('break-glass activation', () => {
  it('is offered on no settings, audit or access page', async () => {
    const world = settingsWorld()
    world.on('GET', '/api/v1/audit-events', { items: [], nextCursor: null })
    world.on('GET', '/api/v1/audit-events/chain', () => problem(503, 'CONTROL_PLANE_DEGRADED', 'x'))
    for (const path of [
      '/settings/products',
      '/settings/environments',
      '/settings/policies',
      '/settings/installation',
      '/settings/notifications',
      '/settings/break-glass',
      '/audit',
    ]) {
      mountApp(path, world)
      await screen.findByRole('heading', { level: 1 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      const offers = [...document.querySelectorAll('button, a')].filter((element) =>
        /activat|break the glass/i.test(element.textContent ?? ''),
      )
      expect(offers, path).toEqual([])
      expect(
        world.requests.filter((r) => r.method === 'POST' && r.path.includes('break-glass')),
      ).toEqual([])
      cleanup()
    }
  })
})
