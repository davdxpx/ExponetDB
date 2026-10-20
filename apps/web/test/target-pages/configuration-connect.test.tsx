import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  AGO,
  BIDI,
  HOSTILE,
  mountOps,
  NOW,
  OpsWorld,
  project,
  TARGET,
  ulid,
  withDefaults,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PAGE = `/t/${TARGET}/configuration`
const CLUSTER = `cls_${ulid(1)}`
const TARGET_ID = 'tgt_00000000000000000000000002'
const ENDPOINTS = new RegExp(`/api/v1/clusters/${CLUSTER}/endpoints$`)
const DATABASES = new RegExp(`/api/v1/clusters/${CLUSTER}/databases$`)
const CREDENTIALS = new RegExp(`/api/v1/clusters/${CLUSTER}/credentials$`)
const HEALTH = /\/api\/v1\/targets\/[^/]+\/health$/
const END_1 = `end_${ulid(1)}`

function endpoint(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `end_${ulid(n)}`,
    clusterId: CLUSTER,
    kind: 'private',
    poolerMode: null,
    host: 'db.example.test',
    port: 5432,
    tlsServerName: 'db.example.test',
    label: `endpoint ${n}`,
    state: 'active',
    createdAt: NOW(),
    retiredAt: null,
    ...over,
  }
}

function database(over: Record<string, unknown> = {}) {
  return {
    id: `dbs_${ulid(1)}`,
    clusterId: CLUSTER,
    name: 'orders',
    state: 'registered',
    createdAt: NOW(),
    observed: null,
    placement: { targetId: TARGET_ID, generation: 1 },
    ...over,
  }
}

function probe(endpointId: string, over: Record<string, unknown> = {}) {
  return {
    durationMs: 12,
    endpoint: { id: endpointId, kind: 'private', label: 'endpoint 1', verified: true },
    errorClass: null,
    observedAt: AGO(60_000),
    outcome: 'ok',
    probe: 'simple',
    tls: 'verified',
    ...over,
  }
}

function world(permissions: readonly string[] = ['registry.manage']): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET, { probes: [probe(END_1)] as never })
  withDefaults(w)
  w.on('GET', /\/api\/v1\/policy-settings$/, { rules: [] })
  w.update(TARGET, {
    placement: {
      clusterId: CLUSTER,
      clusterName: 'main',
      generation: 1,
      managementMode: 'external',
      postgresVersion: '17.2',
      serverName: null,
      since: NOW(),
    },
  })
  w.on('GET', CREDENTIALS, { items: [], truncated: false })
  w.on('GET', ENDPOINTS, { items: [endpoint(1)], truncated: false })
  w.on('GET', DATABASES, { items: [database()], truncated: false })
  w.permissions = [...permissions] as OpsWorld['permissions']
  return w
}

async function connect(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name: 'Connect' })
  const root = heading.closest('[data-slot="page-section"]')
  if (!(root instanceof HTMLElement)) throw new Error('no connect section')
  return root
}

describe('the connect panel of the configuration page', () => {
  it('names the restriction and makes no request for endpoint addresses without registry.manage', async () => {
    const w = world([])
    mountOps(PAGE, w)
    const section = await connect()
    expect(
      within(section).getByText('Only registry administrators can see endpoint addresses'),
    ).toBeVisible()
    await screen.findByRole('heading', { level: 2, name: 'Cluster roles' })
    expect(w.callsTo('GET', ENDPOINTS)).toHaveLength(0)
    expect(w.callsTo('GET', DATABASES)).toHaveLength(0)
  })

  it('shows host, port, database, TLS server name and verify-full, with placeholders and no password', async () => {
    const w = world()
    mountOps(PAGE, w)
    const section = await connect()
    const card = await waitFor(() => {
      const found = section.querySelector(`[data-endpoint="${END_1}"]`)
      if (!(found instanceof HTMLElement)) throw new Error('no endpoint card')
      return found
    })
    expect(within(card).getAllByText('db.example.test', { selector: '[dir=ltr]' })).toHaveLength(2)
    expect(within(card).getByText('5432')).toBeVisible()
    expect(within(card).getByText('orders')).toBeVisible()
    expect(within(card).getByText('verify-full')).toBeVisible()
    expect(card.textContent).toContain(
      'postgresql://<role>:[YOUR-PASSWORD]@db.example.test:5432/orders?sslmode=verify-full',
    )
    expect(card.textContent).toContain(
      'psql "host=db.example.test port=5432 dbname=orders user=<role> sslmode=verify-full"',
    )
    expect(section.textContent).toContain('ExponetDB never holds application passwords')
    expect(within(card).getByText('TLS verified')).toBeVisible()
    expect(within(card).getByText('1 of 1 probes ok')).toBeVisible()
    expect(within(card).getByText('Endpoint identity verified')).toBeVisible()
    // The whole page never builds a line with a real password.
    expect(document.body.textContent).not.toMatch(/:\/\/[^\s:@]+:(?!\[YOUR-PASSWORD\])[^\s@]+@/)
  })

  it('copies the connection URI, placeholders and all', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mountOps(PAGE, world())
    const section = await connect()
    await user.click(await within(section).findByRole('button', { name: 'Copy connection URI' }))
    expect(writeText).toHaveBeenCalledWith(
      'postgresql://<role>:[YOUR-PASSWORD]@db.example.test:5432/orders?sslmode=verify-full',
    )
    expect(await screen.findByText('Connection URI copied')).toBeVisible()
  })

  it('separates direct endpoints from a pooler and leaves out retired and local socket endpoints', async () => {
    const w = world()
    w.on('GET', ENDPOINTS, {
      items: [
        endpoint(1),
        endpoint(2, { kind: 'pooler', poolerMode: 'transaction', port: 6432, label: 'pgbouncer' }),
        endpoint(3, { state: 'retired', retiredAt: NOW(), label: 'old one' }),
        endpoint(4, { kind: 'local_socket', label: 'socket' }),
      ],
      truncated: false,
    })
    mountOps(PAGE, w)
    const section = await connect()
    await within(section).findByText('pgbouncer')
    expect(section.querySelectorAll('[data-endpoint]')).toHaveLength(2)
    expect(within(section).getByText('Pooler, transaction mode')).toBeVisible()
    expect(within(section).getByText('Direct, private')).toBeVisible()
    expect(within(section).queryByText('old one')).toBeNull()
    expect(within(section).queryByText('socket')).toBeNull()
    expect(within(section).getByText(/1 local socket endpoints are not listed/)).toBeVisible()
    expect(section.textContent).toContain('@db.example.test:6432/orders')
  })

  it('checks the TLS server name and connects to the address for an endpoint that is an address', async () => {
    const w = world()
    w.on('GET', ENDPOINTS, {
      items: [endpoint(1, { host: '10.8.2.5', tlsServerName: 'db.internal.example' })],
      truncated: false,
    })
    mountOps(PAGE, w)
    const section = await connect()
    await waitFor(() => expect(section.textContent).toContain('hostaddr=10.8.2.5'))
    expect(section.textContent).toContain('@db.internal.example:5432/orders')
    expect(within(section).getByText(/checked against db\.internal\.example/)).toBeVisible()
  })

  it('says the endpoint was never probed when no probe names it, and shows a failed probe read', async () => {
    const w = world()
    w.on('GET', ENDPOINTS, { items: [endpoint(1), endpoint(2)], truncated: false })
    mountOps(PAGE, w)
    const section = await connect()
    await within(section).findByText('1 of 1 probes ok')
    expect(within(section).getByText(/No probe of this endpoint is recorded yet/)).toBeVisible()
    cleanup()

    const failed = world()
    failed.fail('GET', HEALTH, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, failed)
    const second = await connect()
    expect(await within(second).findByText(/The probe results could not be read/)).toBeVisible()
    expect(within(second).queryByText('TLS verified')).toBeNull()
    cleanup()

    const denied = world()
    denied.fail('GET', HEALTH, 403, 'PERMISSION_DENIED')
    mountOps(PAGE, denied)
    const third = await connect()
    expect(await within(third).findByText(/need the diagnostics\.read permission/)).toBeVisible()
  })

  it('shows a failed read of the endpoints as failed, never as no endpoint', async () => {
    const w = world()
    w.fail('GET', ENDPOINTS, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    const section = await connect()
    expect(await within(section).findByText(/Could not read connection endpoints/)).toBeVisible()
    expect(within(section).queryByText(/no active endpoint/)).toBeNull()
  })

  it('names the permission when the server refuses the endpoints read', async () => {
    const w = world()
    w.fail('GET', ENDPOINTS, 403, 'PERMISSION_DENIED')
    mountOps(PAGE, w)
    const section = await connect()
    expect(await within(section).findByText('registry.manage')).toBeVisible()
    expect(within(section).queryByText(/no active endpoint/)).toBeNull()
  })

  it('shows an earlier read of the endpoints as stale, with its age and a refresh', async () => {
    const w = world()
    const { queryClient } = mountOps(PAGE, w)
    const section = await connect()
    await within(section).findByText('endpoint 1')
    w.fail('GET', ENDPOINTS, 500, 'INTERNAL_ERROR')
    await act(async () => {
      await queryClient.refetchQueries()
    })
    await waitFor(() => expect(section.querySelector('[data-state="stale"]')).not.toBeNull())
    expect(section.querySelector('[data-state="stale"]')?.textContent).toMatch(
      /Showing an earlier read of .*Observed/,
    )
    expect(within(section).getByRole('button', { name: 'Refresh' })).toBeVisible()
    expect(within(section).getByText('endpoint 1')).toBeVisible()
  })

  it('names what is missing when the endpoint list is cut off', async () => {
    const w = world()
    w.on('GET', ENDPOINTS, { items: [endpoint(1)], truncated: true })
    mountOps(PAGE, w)
    const section = await connect()
    expect(
      await within(section).findByText(/More endpoints exist than this list shows/),
    ).toBeVisible()
    expect(within(section).getByText('endpoint 1')).toBeVisible()
  })

  it('shows the endpoints but no command when the database name is missing, and says so', async () => {
    const w = world()
    w.fail('GET', DATABASES, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    const section = await connect()
    expect(await within(section).findByText(/The database name could not be read/)).toBeVisible()
    expect(within(section).getByText('endpoint 1')).toBeVisible()
    expect(within(section).getByText('Not known')).toBeVisible()
    expect(section.textContent).not.toContain('postgresql://')
    cleanup()

    const unnamed = world()
    unnamed.on('GET', DATABASES, { items: [database({ placement: null })], truncated: false })
    mountOps(PAGE, unnamed)
    const other = await connect()
    expect(
      await within(other).findByText(/the cluster lists no database placed on this target/),
    ).toBeVisible()
    expect(other.textContent).not.toContain('postgresql://')
  })

  it('says the cluster has no active endpoint only after a successful read', async () => {
    const w = world()
    w.on('GET', ENDPOINTS, { items: [endpoint(3, { state: 'retired' })], truncated: false })
    mountOps(PAGE, w)
    const section = await connect()
    expect(await within(section).findByText(/cluster has no active endpoint/)).toBeVisible()
  })

  it('says a target without a placement has nothing to connect to, and reads nothing', async () => {
    const w = world()
    w.update(TARGET, { placement: null })
    mountOps(PAGE, w)
    const section = await connect()
    expect(
      within(section).getByText(/not placed on a cluster, so there is no endpoint/),
    ).toBeVisible()
    expect(w.callsTo('GET', ENDPOINTS)).toHaveLength(0)
  })

  it('shows hostile labels, hosts and database names as text and builds no command from them', async () => {
    const w = world()
    w.on('GET', ENDPOINTS, {
      items: [
        endpoint(1, {
          label: HOSTILE,
          host: `db${BIDI}.example.test`,
          tlsServerName: 'db.example.test',
        }),
      ],
      truncated: false,
    })
    w.on('GET', DATABASES, {
      items: [database({ name: `x"; rm -rf ~; "${BIDI}` })],
      truncated: false,
    })
    mountOps(PAGE, w)
    const section = await connect()
    await waitFor(() => expect(section.textContent).toContain('⟨U+202E⟩'))
    expect(section.querySelector('script')).toBeNull()
    expect(section.textContent).not.toContain(BIDI)
    expect(section.textContent).toContain('No command is shown')
    expect(section.textContent).not.toContain('psql "')
    expect(section.textContent).not.toContain('postgresql://')
  })

  it('has no accessibility violations', async () => {
    mountOps(PAGE, world())
    const section = await connect()
    await within(section).findByText('endpoint 1')
    await within(section).findByText('TLS verified')
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the identity rows of the configuration page', () => {
  it('copy the target path and the target id', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mountOps(PAGE, world([]))
    const target = await screen.findByRole('heading', { level: 2, name: 'Target' })
    const section = target.closest('[data-slot="page-section"]') as HTMLElement
    await user.click(await within(section).findByRole('button', { name: 'Copy target path' }))
    expect(writeText).toHaveBeenLastCalledWith(TARGET)
    expect(await screen.findByText('Target path copied')).toBeVisible()
    await user.click(within(section).getByRole('button', { name: 'Copy target ID' }))
    expect(writeText).toHaveBeenLastCalledWith(TARGET_ID)
    expect(await screen.findByText('Target ID copied')).toBeVisible()
    expect(within(section).getByText(TARGET_ID)).toBeVisible()
  })

  it('say so when the clipboard refuses', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mountOps(PAGE, world([]))
    await user.click(await screen.findByRole('button', { name: 'Copy target path' }))
    expect(await screen.findByText('Could not copy to the clipboard')).toBeVisible()
  })
})
