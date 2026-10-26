import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import type { ConnectEndpoint } from '../../src/features/configuration/connect-model.ts'
import {
  apiSnippets,
  appSnippets,
  cliCommands,
  isConnectMode,
} from '../../src/features/connect/target-connect-model.ts'
import {
  CLUSTER,
  iso,
  mountApp,
  targetDetailFixture,
  targetFixture,
  World,
} from '../fleet/support.tsx'

afterEach(cleanup)

const endpoint = (over: Partial<ConnectEndpoint> = {}): ConnectEndpoint => ({
  id: 'end_01M4S9000000000000000000E1',
  label: 'private',
  kind: 'private',
  poolerMode: null,
  host: 'db.internal.example',
  port: 5432,
  tlsServerName: 'db.internal.example',
  ...over,
})

describe('the Connect templates', () => {
  it('builds driver templates with TLS checked against the name and no secret', () => {
    const built = appSnippets(endpoint(), 'orders')
    if (built.kind !== 'snippets') throw new Error('expected snippets')
    expect(built.snippets.env).toContain('PGSSLMODE=verify-full')
    expect(built.snippets.env).toContain('PGPASSWORD=[YOUR-PASSWORD]')
    expect(built.snippets.python).toContain('sslmode="verify-full"')
    expect(built.snippets.node).toContain('rejectUnauthorized: true')
    expect(built.snippets.go).toContain('sslmode=verify-full')
    for (const text of Object.values(built.snippets)) {
      expect(text).not.toMatch(/password\s*[:=]\s*['"][^<[]/i)
    }
  })

  it('checks the certificate against the TLS name when the endpoint is an address', () => {
    const built = appSnippets(endpoint({ host: '10.0.0.5', tlsServerName: 'db.example' }), 'orders')
    if (built.kind !== 'snippets') throw new Error('expected snippets')
    expect(built.snippets.env).toContain('PGHOST=db.example')
    expect(built.snippets.env).toContain('PGHOSTADDR=10.0.0.5')
    expect(built.snippets.python).toContain('hostaddr="10.0.0.5"')
    expect(built.snippets.node).toContain("servername: 'db.example'")
    expect(built.snippets.go).toContain('TLSConfig.ServerName = "db.example"')
  })

  it('refuses a host or database that is not safe to paste instead of escaping it', () => {
    expect(appSnippets(endpoint({ host: "db'; rm -rf /" }), 'orders')).toEqual({
      kind: 'unsafe',
      what: 'host',
    })
    expect(appSnippets(endpoint(), "orders'); DROP")).toEqual({ kind: 'unsafe', what: 'database' })
  })

  it('names only real CLI commands and the management API, never a database connection', () => {
    const commands = cliCommands('https://db.example.com', 'shop/platform/staging')
    expect(commands[0]).toBe(
      'exponetdb login --server https://db.example.com --preset developer:nonprod',
    )
    expect(commands.join('\n')).not.toMatch(/psql|password/i)
    const api = apiSnippets('https://db.example.com', 'shop/platform/staging')
    expect(api.curl).toContain('/api/v1/targets/shop%2Fplatform%2Fstaging')
    expect(api.curl).toContain('$EXPONETDB_API_KEY')
    expect(isConnectMode('direct')).toBe(true)
    expect(isConnectMode('constructor')).toBe(false)
  })
})

function targetWorld(): World {
  const world = new World()
  const summary = targetFixture('shop/platform/staging', {
    projectId: 'prj_01M4S9000000000000000000J1',
  })
  world.targetPages = [[summary]]
  world.targetDetails.set(summary.path, targetDetailFixture(summary))
  world.endpoints.set(CLUSTER, [
    {
      id: 'end_01M4S9000000000000000000E1',
      clusterId: CLUSTER,
      kind: 'private',
      poolerMode: null,
      host: 'db.internal.example',
      port: 5432,
      tlsServerName: 'db.internal.example',
      label: 'private',
      state: 'active',
      createdAt: iso(),
      retiredAt: null,
    },
  ])
  world.databases = [
    {
      id: 'dbs_01M4S9000000000000000000D1',
      clusterId: CLUSTER,
      name: 'orders',
      state: 'registered',
      createdAt: iso(),
      observed: null,
      placement: { generation: 1, targetId: summary.id },
    },
  ]
  return world
}

describe('the Connect sheet of a target', () => {
  it('opens from the header as a wide dialog, keeps its state in the address and closes with Back', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging', targetWorld())
    const button = await screen.findByRole('button', { name: 'Connect' })
    await user.click(button)
    const dialog = await screen.findByRole('dialog', { name: /Connect to shop\/platform\/staging/ })
    expect(router.state.location.search).toMatchObject({ connect: 'direct' })
    expect(within(dialog).getByRole('radio', { name: /Direct connection/ })).toBeChecked()
    await user.click(within(dialog).getByRole('radio', { name: /ExponetDB CLI/ }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ connect: 'cli' }))
    expect(
      within(dialog).getAllByText(/exponetdb (login|target show|migration status|migration plan)/),
    ).not.toHaveLength(0)
    router.history.back()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.search).not.toHaveProperty('connect')
  })

  it('opens from a link and returns focus to the button when Escape closes it', async () => {
    const user = userEvent.setup()
    mountApp('/t/shop/platform/staging?connect=mcp', targetWorld())
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('radio', { name: /AI agent/ })).toBeChecked()
    expect(dialog).toHaveTextContent(`${window.location.origin}/mcp`)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveFocus()
  })

  it('closes with Escape after the button opened it, and never goes back past the page later', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging', targetWorld())
    const button = await screen.findByRole('button', { name: 'Connect' })
    await user.click(button)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/t/shop/platform/staging')
    expect(router.state.location.search).not.toHaveProperty('connect')
    // Opened by the button, closed with Back; later opened by a link from another page:
    // Escape then closes it in place instead of going back to that other page.
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await screen.findByRole('dialog')
    router.history.back()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    router.history.push('/t/shop/platform/staging/migrations')
    router.history.push('/t/shop/platform/staging?connect=mcp')
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/t/shop/platform/staging')
  })

  it('ignores a mode outside the allowlist', async () => {
    mountApp('/t/shop/platform/staging?connect=__proto__', targetWorld())
    await screen.findByRole('button', { name: 'Connect' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows addresses and templates only to registry administrators, and reads nothing for others', async () => {
    const world = targetWorld()
    mountApp('/t/shop/platform/staging?connect=app', world)
    const dialog = await screen.findByRole('dialog')
    expect(
      await within(dialog).findByText('Only registry administrators can see endpoint addresses'),
    ).toBeVisible()
    expect(world.gets(`/api/v1/clusters/${CLUSTER}/endpoints`)).toHaveLength(0)
  })

  it('builds the templates from the endpoint record for a registry administrator', async () => {
    const user = userEvent.setup()
    const world = targetWorld()
    world.permissions = ['registry.manage']
    mountApp('/t/shop/platform/staging?connect=app', world)
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/PGHOST=db\.internal\.example/)).toBeVisible()
    await user.click(within(dialog).getByRole('tab', { name: 'Python (psycopg)' }))
    expect(await within(dialog).findByText(/dbname="orders"/)).toBeVisible()
    expect(dialog.textContent).not.toMatch(/password="[^[]/)
  })

  it('has no accessibility violations while open', async () => {
    mountApp('/t/shop/platform/staging?connect=api', targetWorld())
    await screen.findByRole('dialog')
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe("the Connect sheet of a project's home", () => {
  it('asks for the environment, defaulting to the first non-production one', async () => {
    const user = userEvent.setup()
    const world = targetWorld()
    const production = targetFixture('shop/platform/production', {
      tier: 'prod',
      projectId: 'prj_01M4S9000000000000000000J1',
    })
    world.targetPages = [[...(world.targetPages[0] ?? []), production]]
    world.targetDetails.set(production.path, targetDetailFixture(production))
    const { router } = mountApp('/p/shop/platform', world)
    await user.click(await screen.findByRole('button', { name: 'Connect' }))
    const dialog = await screen.findByRole('dialog')
    const select = await within(dialog).findByLabelText('Environment')
    expect(select).toHaveValue('staging')
    await user.selectOptions(select, 'production')
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ environment: 'production' }),
    )
    expect(
      within(dialog).getByRole('heading', { name: /shop\/platform\/production/ }),
    ).toBeVisible()
  })
})

describe('the read states of the Connect sheet', () => {
  it('shows a failed target read in the sheet as failed, with no templates', async () => {
    const world = targetWorld()
    world.permissions = ['registry.manage']
    mountApp('/t/shop/platform/staging?connect=app', world)
    await screen.findByRole('dialog')
    world.targetDetails.clear()
    world.failures.set('GET /api/v1/targets/shop%2Fplatform%2Fstaging', {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry did not answer.',
    })
    cleanup()
    mountApp('/t/shop/platform/staging?connect=app', world)
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findAllByText(/The registry did not answer/)).not.toHaveLength(0)
    expect(dialog.textContent).not.toContain('PGHOST=')
  })

  it('says a project with no database has nothing to connect to (empty)', async () => {
    const world = new World()
    world.targetPages = [[]]
    mountApp('/p/shop/platform?connect=direct', world)
    const dialog = await screen.findByRole('dialog')
    expect(
      await within(dialog).findByText(
        'This project has no database yet, so there is nothing to connect to.',
      ),
    ).toBeVisible()
  })
})
