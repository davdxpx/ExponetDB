import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { breakGlassList } from '../admin/fixtures.ts'
import {
  BIDI,
  confirmWithCode,
  deferred,
  expectInert,
  HOSTILE,
  mountApp,
  PLAN,
  plan,
  problem,
  World,
} from '../admin/support.tsx'

afterEach(cleanup)

const PRODUCT = 'prd_01JZ0000000000000000000001'
const OTHER_PRODUCT = 'prd_01JZ0000000000000000000002'
const PLATFORM = 'prj_01JZ0000000000000000000001'
const BILLING = 'prj_01JZ0000000000000000000002'

function project(over: Record<string, unknown> = {}) {
  return {
    id: PLATFORM,
    productId: PRODUCT,
    slug: 'platform',
    path: 'shop/platform',
    displayName: 'Platform',
    revision: 3,
    evidenceOverride: {},
    managedScope: { includeSchemas: null, excludeSchemas: [] },
    ...over,
  }
}

function projectsWorld(permissions?: string[]): World {
  const world = new World()
  if (permissions !== undefined) world.permissions = permissions as World['permissions']
  world.on('GET', '/api/v1/break-glass-grants', breakGlassList([]))
  world.on('GET', '/api/v1/projects', {
    items: [
      project(),
      project({
        id: BILLING,
        slug: 'billing',
        path: 'shop/billing',
        displayName: 'Billing',
        revision: 1,
        evidenceOverride: { staging: 'none' },
        managedScope: { includeSchemas: ['public', 'billing'], excludeSchemas: ['scratch'] },
      }),
    ],
    nextCursor: null,
  })
  world.on('GET', '/api/v1/products', {
    items: [
      { id: PRODUCT, slug: 'shop', displayName: 'Shop' },
      { id: OTHER_PRODUCT, slug: 'acme', displayName: 'Acme' },
    ],
    nextCursor: null,
  })
  return world
}

async function row(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(`li[data-project="${id}"]`)
    if (found === null) throw new Error(`no project ${id}`)
    return found
  })
}

describe('the projects page', () => {
  it('lists projects with their path, managed schemas, evidence override and revision', async () => {
    mountApp('/settings/projects', projectsWorld())
    const platform = await row(PLATFORM)
    expect(platform.textContent).toContain('Platform')
    expect(platform.textContent).toContain('shop/platform')
    expect(platform.textContent).toContain('Every schema except the system schemas')
    expect(platform.textContent).toContain('Follows the evidence chain of its product')
    expect(platform.textContent).toContain('Revision 3')
    const billing = await row(BILLING)
    expect(billing.textContent).toContain('Only')
    for (const name of ['public', 'billing', 'scratch', 'staging']) {
      expect(within(billing).getAllByText(name, { selector: '[dir=ltr]' }).length).toBeGreaterThan(
        0,
      )
    }
    expect(billing.textContent).toContain('Excluded:')
    expect(billing.textContent).toContain('Skips the evidence chain for')
  })

  it('offers neither a form nor an edit without registry.manage, and says which permission it needs', async () => {
    const world = projectsWorld(['targets.read'])
    mountApp('/settings/projects', world)
    await row(PLATFORM)
    expect(document.getElementById('project-create')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit project' })).toBeNull()
    expect(screen.getByText(/needs the permission registry\.manage/)).toBeInTheDocument()
    // The page reads the projects only: the products list is for the form it does not show.
    expect(world.reads('/api/v1/products')).toHaveLength(0)
  })

  it('shows loading, a failed read and a partial list truthfully, and never a failed read as empty', async () => {
    const world = projectsWorld()
    const hold = deferred()
    world.on('GET', '/api/v1/projects', async () => {
      await hold.promise
      return problem(503, 'CONTROL_PLANE_DEGRADED', 'Down.')
    })
    mountApp('/settings/projects', world)
    expect(await screen.findByText('Loading Project list')).toBeInTheDocument()
    hold.resolve()
    expect(
      await screen.findByText('Could not read Project list', {}, { timeout: 10_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).toBeNull()
    cleanup()

    const partial = projectsWorld()
    partial.on('GET', '/api/v1/projects', { items: [project()], nextCursor: 'more' })
    mountApp('/settings/projects', partial)
    expect(await screen.findByText('Showing part of Project list')).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).toBeNull()
  })

  it('names the missing permission when the server refuses the read', async () => {
    const world = projectsWorld()
    world.on('GET', '/api/v1/projects', problem(403, 'PERMISSION_DENIED'))
    mountApp('/settings/projects', world)
    expect(await screen.findByText('targets.read')).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).toBeNull()
  })

  it('says there are no projects only after a successful read, and still offers the form', async () => {
    const world = projectsWorld()
    world.on('GET', '/api/v1/projects', { items: [], nextCursor: null })
    mountApp('/settings/projects', world)
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    expect(document.getElementById('project-create')).not.toBeNull()
  })

  it('shows an earlier read of the projects as stale, with its age and a refresh', async () => {
    const world = projectsWorld()
    const { queryClient } = mountApp('/settings/projects', world)
    await row(PLATFORM)
    world.on('GET', '/api/v1/projects', problem(500, 'INTERNAL', 'The registry did not answer.'))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['settings', 'projects'] })
    })
    expect(await screen.findByText(/Showing an earlier read of Project list/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0)
    expect(await row(PLATFORM)).toBeInTheDocument()
  })

  it('shows hostile names, paths and schema names as marked text', async () => {
    const world = projectsWorld()
    world.on('GET', '/api/v1/projects', {
      items: [
        project({
          displayName: HOSTILE,
          path: `shop/${BIDI}x`,
          managedScope: {
            includeSchemas: [`sch${BIDI}ema`, '<img src=x onerror=alert(1)>'],
            excludeSchemas: [],
          },
        }),
      ],
      nextCursor: null,
    })
    const { container } = mountApp('/settings/projects', world)
    const item = await row(PLATFORM)
    expect(item.textContent).toContain('⟨U+202E⟩')
    expect(item.textContent).not.toContain(BIDI)
    expect(item.textContent).toContain('<img src=x onerror=alert(1)>')
    expectInert(container)
  })
})

describe('creating a project', () => {
  it('checks the fields before it sends anything, then plans the project and opens the review', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    world.on('POST', '/api/v1/projects', (request) => {
      expect(request.body).toEqual({
        product: 'shop',
        slug: 'billing-2',
        displayName: 'Billing 2',
        managedScope: { includeSchemas: ['billing', 'public'], excludeSchemas: ['scratch'] },
      })
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/settings/projects', world)
    await row(PLATFORM)
    const form = document.getElementById('project-create') as HTMLElement
    await within(form).findByRole('option', { name: 'acme' })
    await user.click(within(form).getByRole('button', { name: 'Create project plan' }))
    expect(await within(form).findByText('Choose a product.')).toBeInTheDocument()
    expect(within(form).getAllByText(/Use lower-case letters/).length).toBeGreaterThan(0)
    expect(world.changes).toEqual([])
    fireEvent.change(within(form).getByLabelText('Product'), { target: { value: 'shop' } })
    fireEvent.change(within(form).getByLabelText('Slug'), { target: { value: 'Not A Slug' } })
    fireEvent.change(within(form).getByLabelText('Display name'), {
      target: { value: 'Billing 2' },
    })
    await user.click(within(form).getByRole('button', { name: 'Create project plan' }))
    expect(await within(form).findByText(/Use lower-case letters/)).toBeInTheDocument()
    expect(world.changes).toEqual([])
    fireEvent.change(within(form).getByLabelText('Slug'), { target: { value: 'billing-2' } })
    fireEvent.change(within(form).getByLabelText('Included schemas'), {
      target: { value: 'public\n\n  billing  \n' },
    })
    fireEvent.change(within(form).getByLabelText('Excluded schemas'), {
      target: { value: 'scratch' },
    })
    await user.click(within(form).getByRole('button', { name: 'Create project plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toHaveLength(1)
  })

  it('sends no managed scope when both lists are empty, and asks the person for no product slug it does not list', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    world.on('POST', '/api/v1/projects', (request) => {
      expect(request.body).toEqual({ product: 'acme', slug: 'core', displayName: 'Core' })
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/settings/projects', world)
    await row(PLATFORM)
    const form = document.getElementById('project-create') as HTMLElement
    await within(form).findByRole('option', { name: 'acme' })
    // The options are the slugs of the products read, nothing else.
    expect(
      within(within(form).getByLabelText('Product'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a product', 'shop', 'acme'])
    fireEvent.change(within(form).getByLabelText('Product'), { target: { value: 'acme' } })
    fireEvent.change(within(form).getByLabelText('Slug'), { target: { value: 'core' } })
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Core' } })
    await user.click(within(form).getByRole('button', { name: 'Create project plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('refuses a schema list with a control character or more than 256 names before sending', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    mountApp('/settings/projects', world)
    await row(PLATFORM)
    const form = document.getElementById('project-create') as HTMLElement
    await within(form).findByRole('option', { name: 'acme' })
    fireEvent.change(within(form).getByLabelText('Product'), { target: { value: 'shop' } })
    fireEvent.change(within(form).getByLabelText('Slug'), { target: { value: 'ok' } })
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Ok' } })
    fireEvent.change(within(form).getByLabelText('Included schemas'), {
      target: { value: 'good\nbad\u0007name' },
    })
    fireEvent.change(within(form).getByLabelText('Excluded schemas'), {
      target: { value: Array.from({ length: 257 }, (_, i) => `s${i}`).join('\n') },
    })
    await user.click(within(form).getByRole('button', { name: 'Create project plan' }))
    expect(await within(form).findAllByText(/Use 1 to 63 characters per name/)).toHaveLength(2)
    expect(world.changes).toEqual([])
  })

  it('shows the refusal with its code and stays on the page', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    world.on('POST', '/api/v1/projects', problem(409, 'REGISTRY_CONFLICT', 'That slug is taken.'))
    const { router } = mountApp('/settings/projects', world)
    await row(PLATFORM)
    const form = document.getElementById('project-create') as HTMLElement
    await within(form).findByRole('option', { name: 'acme' })
    fireEvent.change(within(form).getByLabelText('Product'), { target: { value: 'shop' } })
    fireEvent.change(within(form).getByLabelText('Slug'), { target: { value: 'platform' } })
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Again' } })
    await user.click(within(form).getByRole('button', { name: 'Create project plan' }))
    expect(
      await within(form).findByText('That slug is taken. (REGISTRY_CONFLICT)'),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings/projects')
  })

  it('asks for a fresh proof when the server asks, then plans once', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    world.needsProof = true
    let created = 0
    world.on('POST', '/api/v1/projects', () => {
      created += 1
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/settings/projects', world)
    await row(PLATFORM)
    const form = document.getElementById('project-create') as HTMLElement
    await within(form).findByRole('option', { name: 'acme' })
    fireEvent.change(within(form).getByLabelText('Product'), { target: { value: 'shop' } })
    fireEvent.change(within(form).getByLabelText('Slug'), { target: { value: 'core' } })
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Core' } })
    await user.click(within(form).getByRole('button', { name: 'Create project plan' }))
    await confirmWithCode(user)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(created).toBe(1)
  })

  it('points to the products page when no product is registered, after a successful read only', async () => {
    const world = projectsWorld()
    world.on('GET', '/api/v1/products', { items: [], nextCursor: null })
    mountApp('/settings/projects', world)
    await row(PLATFORM)
    const form = document.getElementById('project-create') as HTMLElement
    expect(await within(form).findByText(/No product is registered/)).toBeInTheDocument()
    expect(within(form).getByRole('link', { name: 'Add a product' })).toHaveAttribute(
      'href',
      '/settings/products',
    )
    expect(within(form).queryByLabelText('Product')).toBeNull()
  })

  it('shows a failed read of the products as failed, never as no product', async () => {
    const world = projectsWorld()
    world.on('GET', '/api/v1/products', problem(500, 'INTERNAL', 'The registry did not answer.'))
    mountApp('/settings/projects', world)
    await row(PLATFORM)
    const form = document.getElementById('project-create') as HTMLElement
    expect(await within(form).findByText(/Could not read Product list/)).toBeInTheDocument()
    expect(within(form).queryByText(/No product is registered/)).toBeNull()
    expect(within(form).queryByLabelText('Product')).toBeNull()
  })
})

describe('changing a project', () => {
  async function open(world: World, id: string): Promise<{ item: HTMLElement; form: HTMLElement }> {
    const user = userEvent.setup()
    const item = await row(id)
    const before = world.changes.length
    await user.click(within(item).getByRole('button', { name: 'Edit project' }))
    const form = await within(item).findByRole('form', { name: /^Change project / })
    // Opening the form sends nothing.
    expect(world.changes).toHaveLength(before)
    return { item, form }
  }

  it('shows before and after for what changed, and plans only those fields', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    world.on('POST', `/api/v1/projects/${PLATFORM}/change-plans`, (request) => {
      expect(request.body).toEqual({
        displayName: 'Platform core',
        managedScope: { excludeSchemas: ['scratch', 'tmp'] },
      })
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/settings/projects', world)
    const { form } = await open(world, PLATFORM)
    // Nothing changed yet: no preview.
    expect(within(form).queryByRole('table')).toBeNull()
    fireEvent.change(within(form).getByLabelText('Display name'), {
      target: { value: 'Platform core' },
    })
    fireEvent.change(within(form).getByLabelText('Excluded schemas'), {
      target: { value: 'tmp\nscratch\ntmp' },
    })
    const table = await within(form).findByRole('table', {
      name: 'Fields of project shop/platform that the plan would change',
    })
    const name = table.querySelector('[data-diff="name"]') as HTMLElement
    expect(name.textContent).toContain('Platform')
    expect(name.textContent).toContain('Platform core')
    const exclude = table.querySelector('[data-diff="exclude"]') as HTMLElement
    expect(exclude.textContent).toContain('None')
    expect(exclude.textContent).toContain('scratch')
    expect(exclude.textContent).toContain('tmp')
    expect(table.querySelector('[data-diff="include"]')).toBeNull()
    await user.click(within(form).getByRole('button', { name: 'Create project change plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toHaveLength(1)
  })

  it('sends an include list, and leaves it out when it is emptied again', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    const bodies: unknown[] = []
    world.on('POST', `/api/v1/projects/${PLATFORM}/change-plans`, (request) => {
      bodies.push(request.body)
      return { status: 201, json: plan() }
    })
    world.on('POST', `/api/v1/projects/${BILLING}/change-plans`, (request) => {
      bodies.push(request.body)
      return { status: 201, json: plan() }
    })
    mountApp('/settings/projects', world)
    const first = await open(world, PLATFORM)
    fireEvent.change(within(first.form).getByLabelText('Included schemas'), {
      target: { value: 'public' },
    })
    const include = (await within(first.form).findByRole('table')).querySelector(
      '[data-diff="include"]',
    ) as HTMLElement
    expect(include.textContent).toContain('Every schema except the system schemas')
    expect(include.textContent).toContain('public')
    await user.click(within(first.form).getByRole('button', { name: 'Create project change plan' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ managedScope: { includeSchemas: ['public'], excludeSchemas: [] } })
    cleanup()

    mountApp('/settings/projects', world)
    const second = await open(world, BILLING)
    fireEvent.change(within(second.form).getByLabelText('Included schemas'), {
      target: { value: '' },
    })
    await user.click(
      within(second.form).getByRole('button', { name: 'Create project change plan' }),
    )
    await waitFor(() => expect(bodies).toHaveLength(2))
    // No include list in the body means "every schema except the system schemas".
    expect(bodies[1]).toEqual({ managedScope: { excludeSchemas: ['scratch'] } })
  })

  it('does not send a change that changes nothing, and says so', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    mountApp('/settings/projects', world)
    const { form } = await open(world, BILLING)
    // The same schemas in another order and with blanks are the same scope.
    fireEvent.change(within(form).getByLabelText('Included schemas'), {
      target: { value: '\nbilling\n public ' },
    })
    expect(within(form).queryByRole('table')).toBeNull()
    await user.click(within(form).getByRole('button', { name: 'Create project change plan' }))
    expect(await within(form).findByText(/Nothing changed yet/)).toBeInTheDocument()
    expect(world.changes).toEqual([])
  })

  it('checks the name and the schema names before it sends', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    mountApp('/settings/projects', world)
    const { form } = await open(world, PLATFORM)
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: '' } })
    fireEvent.change(within(form).getByLabelText('Excluded schemas'), {
      target: { value: `a\n${'x'.repeat(64)}` },
    })
    await user.click(within(form).getByRole('button', { name: 'Create project change plan' }))
    expect(await within(form).findByText(/Enter 1 to 120 characters/)).toBeInTheDocument()
    expect(within(form).getByText(/Use 1 to 63 characters per name/)).toBeInTheDocument()
    expect(world.changes).toEqual([])
  })

  it('shows the refusal with its code, for example when the project changed meanwhile', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    world.on(
      'POST',
      `/api/v1/projects/${PLATFORM}/change-plans`,
      problem(409, 'REGISTRY_CONFLICT', 'The project changed since you read it.'),
    )
    const { router } = mountApp('/settings/projects', world)
    const { form } = await open(world, PLATFORM)
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'New' } })
    await user.click(within(form).getByRole('button', { name: 'Create project change plan' }))
    expect(
      await within(form).findByText('The project changed since you read it. (REGISTRY_CONFLICT)'),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings/projects')
  })

  it('shows hostile schema names in the preview as marked text', async () => {
    const world = projectsWorld()
    const { container } = mountApp('/settings/projects', world)
    const { form } = await open(world, PLATFORM)
    fireEvent.change(within(form).getByLabelText('Excluded schemas'), {
      target: { value: `evil${BIDI}name\n<script>alert(1)</script>` },
    })
    const table = await within(form).findByRole('table')
    expect(table.textContent).toContain('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
    expect(table.textContent).toContain('<script>alert(1)</script>')
    expectInert(container)
  })
})

describe('accessibility', () => {
  it('has no violations with the list, the form and an edit with a preview', async () => {
    const user = userEvent.setup()
    const world = projectsWorld()
    const { container } = mountApp('/settings/projects', world)
    const item = await row(PLATFORM)
    await within(document.getElementById('project-create') as HTMLElement).findByRole('option', {
      name: 'acme',
    })
    expect(await axeViolations(container)).toEqual([])
    await user.click(within(item).getByRole('button', { name: 'Edit project' }))
    const form = await within(item).findByRole('form', { name: /^Change project / })
    fireEvent.change(within(form).getByLabelText('Display name'), { target: { value: 'Other' } })
    await within(form).findByRole('table')
    expect(await axeViolations(container)).toEqual([])
  })
})
