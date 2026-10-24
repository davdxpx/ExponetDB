import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  CLUSTER,
  DIGEST,
  DiagnosticsWorld,
  lockGraph,
  mountDiagnostics,
  project,
  SECRET_TEXT,
  session,
  sessionList,
  TAG,
  wait,
  ZWSP,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

const PATH = '/t/shop/platform/staging/connections'
const TARGET = 'shop/platform/staging'

function world(): DiagnosticsWorld {
  const w = new DiagnosticsWorld()
  project(w)
  w.sample(TARGET)
  w.sessions = sessionList([session()])
  w.locks = lockGraph([])
  return w
}

const sessionsSection = () => screen.findByRole('heading', { level: 2, name: 'Sessions' })

describe('the sessions', () => {
  it('groups sessions by role and application and tells the states apart', async () => {
    const w = world()
    w.sessions = sessionList([
      session({
        pid: 11,
        role: 'app_rw',
        applicationName: 'shop-api',
        state: 'active',
        queryAgeMs: 4_000,
        stateAgeMs: 4_000,
      }),
      session({ pid: 12, role: 'app_rw', applicationName: 'shop-api', state: 'idle' }),
      session({
        pid: 13,
        role: 'app_rw',
        applicationName: 'shop-worker',
        state: 'idle in transaction',
        stateAgeMs: 125_000,
        transactionAgeMs: 3_725_000,
      }),
      session({
        pid: 14,
        role: 'reporting',
        applicationName: '',
        state: 'active',
        waitEvent: { type: 'Lock', event: 'transactionid' },
      }),
      session({ pid: 15, role: 'reporting', applicationName: '', state: 'fastpath function call' }),
    ])
    mountDiagnostics(PATH, w)
    await sessionsSection()
    const groups = await screen.findAllByText('Role:')
    expect(groups).toHaveLength(2)
    const roleGroups = document.querySelectorAll('[data-role-group]')
    expect(roleGroups).toHaveLength(2)
    expect(roleGroups[0]).toHaveTextContent('app_rw')
    expect(roleGroups[1]).toHaveTextContent('reporting')
    expect(document.querySelectorAll('[data-application-group]')).toHaveLength(3)
    const state = (pid: number) => document.querySelector(`tr[data-pid="${pid}"]`)
    expect(state(11)).toHaveAttribute('data-state-kind', 'active')
    expect(state(12)).toHaveAttribute('data-state-kind', 'idle')
    expect(state(13)).toHaveAttribute('data-state-kind', 'idle_in_transaction')
    expect(state(14)).toHaveAttribute('data-state-kind', 'waiting')
    expect(state(15)).toHaveAttribute('data-state-kind', 'other')
    // The duration of an idle-in-transaction session and of its transaction.
    expect(state(13)).toHaveTextContent('In this state for 2 min 5 s')
    expect(state(13)).toHaveTextContent('Transaction open for 1 h 2 min')
    expect(state(11)).toHaveTextContent('Query running for 4 s')
    expect(state(14)).toHaveTextContent('Lock: transactionid')
    expect(roleGroups[1]).toHaveTextContent('No application name')
    // A state the page does not know is shown by its own word, never as idle.
    expect(state(15)).toHaveTextContent('fastpath function call')
    const summary = screen.getByRole('list', { name: 'Sessions by state' })
    expect(
      within(summary)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['1 active', '1 waiting', '1 idle in transaction', '1 idle', '1 other'])
  })

  it('shows the source and age of the read', async () => {
    mountDiagnostics(PATH, world())
    await sessionsSection()
    expect((await screen.findAllByText(/^Observed/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0)
  })

  it('marks who blocks whom in the session rows from the lock graph', async () => {
    const w = world()
    w.sessions = sessionList([
      session({ pid: 101, state: 'idle in transaction' }),
      session({ pid: 202, state: 'active', waitEvent: { type: 'Lock', event: 'relation' } }),
    ])
    w.locks = lockGraph([wait({ waitingPid: 202, blockingPids: [101] })])
    mountDiagnostics(PATH, w)
    await sessionsSection()
    await waitFor(() =>
      expect(document.querySelector('tr[data-pid="202"]')).toHaveTextContent(
        'Blocked by process 101',
      ),
    )
    expect(document.querySelector('tr[data-pid="101"]')).toHaveTextContent(
      'Blocks 1 other sessions',
    )
  })

  it('renders hostile statements, roles and application names as marked text, never as markup', async () => {
    const w = world()
    const hostile = `select 1 /*<script>alert(1)</script>*/${BIDI}${ZWSP}${TAG}`
    w.sessions = sessionList([
      session({
        role: `evil${BIDI}role`,
        applicationName: `<img src=x onerror=alert(1)>${ZWSP}`,
        state: 'active',
        statement: { digest: DIGEST, redacted: hostile, truncated: false },
      }),
    ])
    mountDiagnostics(PATH, w)
    await sessionsSection()
    await screen.findAllByText(/⟨U\+202E⟩/)
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    const main = screen.getByRole('main')
    expect(main.textContent).toContain('⟨U+202E⟩')
    expect(main.textContent).toContain('⟨U+200B⟩')
    expect(main.textContent).not.toContain(BIDI)
    expect(main.textContent).not.toContain(ZWSP)
    expect(main.textContent).not.toContain(TAG)
  })

  it('bounds a long statement and offers "Show all"', async () => {
    const w = world()
    w.sessions = sessionList([
      session({
        state: 'active',
        statement: { digest: DIGEST, redacted: `select ${'x'.repeat(2_000)}`, truncated: true },
      }),
    ])
    mountDiagnostics(PATH, w)
    await sessionsSection()
    expect(
      await screen.findByRole('button', { name: /Show all \(2,007 characters\)/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('The server cut this statement.')).toBeInTheDocument()
  })
})

describe('every read state of the sessions', () => {
  it('is loading while the read is out', async () => {
    const w = world()
    let release: (value: unknown) => void = () => undefined
    w.delays.set('/sessions', new Promise((resolve) => (release = resolve)))
    mountDiagnostics(PATH, w)
    await sessionsSection()
    expect(await screen.findByText('Loading sessions')).toBeInTheDocument()
    expect(screen.queryByText(/reported no sessions/)).toBeNull()
    release(undefined)
    expect((await screen.findAllByText('shop-api')).length).toBeGreaterThan(0)
  })

  it('is failed with its code and a retry, and never says there are no sessions', async () => {
    const w = world()
    w.failures.set('/sessions', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'diagnostics.read is missing.',
    })
    mountDiagnostics(PATH, w)
    const heading = await screen.findByRole('heading', {
      level: 3,
      name: 'Could not read sessions',
    })
    // The failure is the sessions section's own; the strip's cards say it too, as their own failure.
    const failed = heading.closest('[data-state="failed"]') as HTMLElement
    expect(within(failed).getByText('diagnostics.read is missing.')).toBeInTheDocument()
    expect(within(failed).getByText('PERMISSION_DENIED')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no sessions.')).toBeInTheDocument()
    expect(screen.queryByText(/reported no sessions/)).toBeNull()
    expect(document.querySelector('table')).toBeNull()
  })

  it('says it cannot tell when the target could not be read live', async () => {
    const w = world()
    w.failures.set('/sessions', {
      status: 503,
      code: 'TARGET_UNAVAILABLE',
      message: 'The connection timed out.',
    })
    mountDiagnostics(PATH, w)
    const state = await screen.findByRole('region', {
      name: 'Cannot tell what the target is doing',
    })
    expect(state).toHaveAttribute('data-state', 'cannot-tell')
    expect(state).toHaveTextContent('The connection timed out. (TARGET_UNAVAILABLE)')
    expect(state).toHaveTextContent('This does not mean there are no sessions')
    expect(screen.queryByText(/reported no sessions/)).toBeNull()
  })

  it('is stale with its age and a refresh when the sample is old', async () => {
    const w = world()
    w.sessions = sessionList([session()], {
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    mountDiagnostics(PATH, w)
    expect(await screen.findByText('Showing an earlier read of sessions')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0)
    expect(screen.getAllByText('shop-api').length).toBeGreaterThan(0)
  })

  it('is partial and names what is missing when the server cut the list', async () => {
    const w = world()
    w.sessions = sessionList([session()], { truncated: true, cap: 500 })
    mountDiagnostics(PATH, w)
    expect(await screen.findByText('Showing part of sessions')).toBeInTheDocument()
    expect(
      screen.getByText('Sessions beyond the first 500; the counts are lower bounds'),
    ).toBeInTheDocument()
  })

  it('is empty only after a successful read', async () => {
    const w = world()
    w.sessions = sessionList([])
    mountDiagnostics(PATH, w)
    expect(
      await screen.findByText('The target reported no sessions other than the observer.'),
    ).toBeInTheDocument()
  })
})

describe('cancel and terminate', () => {
  it('are not buttons; the page names the Wave 9 state', async () => {
    const w = world()
    w.sessions = sessionList([
      session({
        pid: 7,
        state: 'active',
        statement: { digest: DIGEST, redacted: 'select 1', truncated: false },
      }),
    ])
    mountDiagnostics(PATH, w)
    expect(
      await screen.findByRole('heading', {
        name: 'Session cancel and terminate is not available yet',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Cancel and terminate come as planned operations in Wave 9.'),
    ).toBeInTheDocument()
    await screen.findAllByText('shop-api')
    expect(screen.queryByRole('button', { name: /terminate|cancel|kill/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /terminate|cancel|kill/i })).toBeNull()
    expect(w.requests.filter((r) => /terminate|cancel/.test(r))).toEqual([])
  })
})

describe('the target gate', () => {
  it('shows the production cue on a production target', async () => {
    const w = world()
    w.sample('shop/platform/production')
    mountDiagnostics('/t/shop/platform/production/connections', w)
    await screen.findByRole('heading', { level: 1, name: 'Connections' })
    await sessionsSection()
    const cue = document.querySelector('[data-slot="page-header-production-cue"]') as HTMLElement
    expect(within(cue).getByText('Production')).toBeInTheDocument()
  })

  it('shows no production cue on a non-production target', async () => {
    mountDiagnostics(PATH, world())
    await screen.findByRole('heading', { level: 1, name: 'Connections' })
    await sessionsSection()
    expect(document.querySelector('[data-slot="page-header-production-cue"]')).toBeNull()
  })

  it('cannot tell, and reads no sessions, when the health of the target is unknown', async () => {
    const w = world()
    w.sample(TARGET, { state: 'unknown', unknownBecause: 'never_sampled' })
    mountDiagnostics(PATH, w)
    const state = await screen.findByRole('region', {
      name: 'Cannot tell whether the target is reachable',
    })
    expect(state).toHaveTextContent('The target has not been sampled yet.')
    expect(screen.queryByRole('heading', { name: 'Sessions' })).toBeNull()
    expect(w.requests.some((r) => r.endsWith('/sessions'))).toBe(false)
  })

  it('names an unreachable target instead of an empty page', async () => {
    const w = world()
    w.sample(TARGET, { state: 'unreachable' })
    mountDiagnostics(PATH, w)
    expect(
      await screen.findByRole('region', { name: 'The target is unreachable' }),
    ).toBeInTheDocument()
    expect(w.requests.some((r) => r.endsWith('/sessions'))).toBe(false)
  })

  it('cannot tell when the health read itself failed', async () => {
    const w = world()
    w.failures.set('/health', { status: 500, code: 'INTERNAL_ERROR', message: 'Health is down.' })
    mountDiagnostics(PATH, w)
    const state = await screen.findByRole('region', {
      name: 'Cannot tell whether the target is reachable',
    })
    expect(state).toHaveTextContent('Health is down.')
    expect(screen.queryByText(/reported no sessions/)).toBeNull()
  })
})

describe('endpoints and probes', () => {
  function withEndpoints(): DiagnosticsWorld {
    const w = world()
    w.update(TARGET, {
      placement: {
        clusterId: CLUSTER,
        clusterName: 'main',
        generation: 1,
        managementMode: 'agent',
        postgresVersion: '17.2',
        serverName: 'db-01',
        since: '2026-10-01T00:00:00.000Z',
      },
    })
    w.endpoints = {
      truncated: false,
      items: [
        {
          id: 'epn_01M4S9000000000000000000A1',
          clusterId: CLUSTER,
          createdAt: '2026-10-01T00:00:00.000Z',
          host: 'db-01.internal',
          kind: 'private',
          label: 'direct',
          poolerMode: null,
          port: 5432,
          retiredAt: null,
          state: 'active',
          tlsServerName: 'db-01.internal',
        },
        {
          id: 'epn_01M4S9000000000000000000A2',
          clusterId: CLUSTER,
          createdAt: '2026-10-01T00:00:00.000Z',
          host: 'pool.internal',
          kind: 'pooler',
          label: 'pooler',
          poolerMode: 'transaction',
          port: 6432,
          retiredAt: null,
          state: 'active',
          tlsServerName: 'pool.internal',
        },
      ],
    }
    w.sample(TARGET, {
      probes: [
        {
          probe: 'simple',
          outcome: 'ok',
          durationMs: 12,
          tls: 'verified',
          errorClass: null,
          observedAt: new Date().toISOString(),
          endpoint: {
            id: 'epn_01M4S9000000000000000000A1',
            kind: 'private',
            label: 'direct',
            verified: true,
          },
        },
        {
          probe: 'simple',
          outcome: 'timeout',
          durationMs: null,
          tls: 'not_reached',
          errorClass: `net${BIDI}`,
          observedAt: new Date().toISOString(),
          endpoint: {
            id: 'epn_01M4S9000000000000000000A2',
            kind: 'pooler',
            label: 'pooler',
            verified: false,
          },
        },
      ],
    })
    return w
  }

  it('lists the direct and pooler endpoints with the probe result of each', async () => {
    mountDiagnostics(PATH, withEndpoints())
    const table = await screen.findByRole('table', {
      name: 'Endpoints of the cluster with their latest probe results',
    })
    const direct = within(table).getByText('db-01.internal:5432').closest('tr')
    expect(direct).toHaveTextContent('Direct, private')
    expect(direct).toHaveTextContent('simple probe: ok in 12 ms, TLS verified')
    const pooler = within(table).getByText('pool.internal:6432').closest('tr')
    expect(pooler).toHaveTextContent('Pooler, transaction mode')
    expect(pooler).toHaveTextContent(
      'simple probe: timed out, TLS not reached, endpoint identity not verified',
    )
    // A hostile error class is marked text.
    expect(pooler).toHaveTextContent('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
  })

  it('says a target without a placement has no endpoints to list, and asks for none', async () => {
    const w = world()
    mountDiagnostics(PATH, w)
    expect(
      await screen.findByText(
        'The target has no placement, so it has no cluster endpoints to list.',
      ),
    ).toBeInTheDocument()
    expect(w.requests.some((r) => r.includes('/endpoints'))).toBe(false)
  })

  it('shows a failed endpoint read as failed, never as an empty table', async () => {
    const w = withEndpoints()
    w.failures.set('/endpoints', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'No endpoints today.',
    })
    mountDiagnostics(PATH, w)
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Could not read endpoints' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('The cluster has no registered endpoint.')).toBeNull()
  })

  it('says the cluster has no endpoint only after a successful read', async () => {
    const w = withEndpoints()
    w.endpoints = { items: [], truncated: false }
    mountDiagnostics(PATH, w)
    expect(await screen.findByText('The cluster has no registered endpoint.')).toBeInTheDocument()
  })

  it('shows a failed health read as failed probe results', async () => {
    const w = withEndpoints()
    mountDiagnostics(PATH, w)
    await screen.findByRole('table', { name: /Endpoints of the cluster/ })
    cleanup()
    const failed = withEndpoints()
    failed.sample(TARGET, { state: 'healthy' })
    failed.health.delete(TARGET)
    failed.failures.set('/health', { status: 500, code: 'INTERNAL_ERROR' })
    mountDiagnostics(PATH, failed)
    // The gate cannot tell (the page needs health), so no table of endpoints is shown.
    expect(
      await screen.findByRole('region', { name: 'Cannot tell whether the target is reachable' }),
    ).toBeInTheDocument()
  })
})

describe('the raw statement view', () => {
  function rawWorld(): DiagnosticsWorld {
    const w = world()
    w.sessions = sessionList([
      session({
        pid: 7,
        state: 'active',
        statement: { digest: DIGEST, redacted: 'select $1', truncated: false },
      }),
    ])
    w.raw = {
      digest: DIGEST,
      observedAt: new Date().toISOString(),
      origin: {
        view: 'pg_stat_activity',
        pid: 7,
        backendStart: '2026-10-13T08:00:00.000Z',
        queryStart: null,
      },
      redaction: { mode: 'literal', removed: 2 },
      source: 'live',
      targetId: 'tgt_00000000000000000000000001',
      text: SECRET_TEXT,
      truncated: false,
    }
    return w
  }

  it('reads the statement live for one view, with the session identity and no text in the URL', async () => {
    const user = userEvent.setup()
    const w = rawWorld()
    const { router, queryClient } = mountDiagnostics(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'View raw statement' }))
    const dialog = await screen.findByRole('dialog', { name: 'Raw statement' })
    expect(await within(dialog).findByText(SECRET_TEXT)).toBeInTheDocument()
    expect(dialog).toHaveTextContent('Raw statement, secrets removed, read live.')
    expect(dialog).toHaveTextContent('Redaction mode: literals; 2 removed.')
    expect(dialog).toHaveTextContent('Found in the session list: process 7.')
    // One request, for this digest, with the target and the session's identity.
    expect(w.rawRequests).toEqual([
      `/api/v1/statements/${encodeURIComponent(DIGEST)}/raw?target=${encodeURIComponent(TARGET)}&pid=7&backendStart=${encodeURIComponent('2026-10-13T08:00:00.000Z')}`,
    ])
    // The text is nowhere but in the dialog: not in the address, not in storage, not in the cache.
    expect(router.state.location.href).not.toContain('secret_marker_9')
    expect(window.location.href).not.toContain('secret_marker_9')
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('secret_marker_9')
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('secret_marker_9')
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('secret_marker_9')
    // Closing the view discards the text.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByText(SECRET_TEXT)).toBeNull())
    expect(document.body.textContent).not.toContain('secret_marker_9')
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('secret_marker_9')
  })

  it('has no accessibility violations while the statement is shown', async () => {
    const user = userEvent.setup()
    mountDiagnostics(PATH, rawWorld())
    await user.click(await screen.findByRole('button', { name: 'View raw statement' }))
    const dialog = await screen.findByRole('dialog', { name: 'Raw statement' })
    await within(dialog).findByText(SECRET_TEXT)
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('shows hostile raw text as marked text', async () => {
    const user = userEvent.setup()
    const w = rawWorld()
    if (w.raw === undefined) throw new Error('raw')
    w.raw = { ...w.raw, text: `select '<script>x</script>'${BIDI}${ZWSP}${TAG}` }
    mountDiagnostics(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'View raw statement' }))
    const dialog = await screen.findByRole('dialog', { name: 'Raw statement' })
    await within(dialog).findByText(/⟨U\+202E⟩/)
    expect(document.querySelector('script')).toBeNull()
    expect(dialog.textContent).not.toContain(BIDI)
    expect(dialog.textContent).not.toContain(ZWSP)
  })

  it('asks for a fresh proof on REAUTH_REQUIRED and reads again once', async () => {
    const user = userEvent.setup()
    const w = rawWorld()
    w.reauthNeeded = true
    mountDiagnostics(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'View raw statement' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    expect(screen.queryByText(SECRET_TEXT)).toBeNull()
    await user.type(
      within(reauth).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
    expect(await screen.findByText(SECRET_TEXT)).toBeInTheDocument()
    expect(w.rawRequests).toHaveLength(2)
  })

  it('shows nothing when the confirmation is canceled', async () => {
    const user = userEvent.setup()
    const w = rawWorld()
    w.reauthNeeded = true
    mountDiagnostics(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'View raw statement' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.click(within(reauth).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText(/Canceled\. Nothing was changed\./)).toBeInTheDocument()
    expect(screen.queryByText(SECRET_TEXT)).toBeNull()
    expect(w.rawRequests).toHaveLength(1)
  })

  const REASONS: readonly [string, string][] = [
    [
      'not_held',
      'The target does not hold this statement now. It may have finished, and ExponetDB keeps no copy of it.',
    ],
    [
      'target_unreachable',
      'The target could not be read, so ExponetDB cannot tell whether it still holds this statement.',
    ],
    [
      'digest_mismatch',
      'The session now runs a different statement than the one in the list. Read the session list again.',
    ],
    [
      'extension_missing',
      'The statement is no longer in the session list, and pg_stat_statements is not installed or not loaded on the target, so the aggregated statements could not be searched.',
    ],
  ]
  it.each(REASONS)('shows the reason %s truthfully and no text', async (reason, sentence) => {
    const user = userEvent.setup()
    const w = rawWorld()
    w.rawError = { status: 404, code: 'STATEMENT_NOT_AVAILABLE', details: { reason } }
    mountDiagnostics(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'View raw statement' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Statement not available')
    expect(alert).toHaveTextContent(sentence)
    expect(alert).toHaveTextContent('No stored or invented text is shown.')
    expect(screen.queryByText(SECRET_TEXT)).toBeNull()
    // The other reasons' sentences are not shown.
    for (const [other, otherSentence] of REASONS) {
      if (other !== reason) expect(alert).not.toHaveTextContent(otherSentence)
    }
  })

  it('names a reason it does not know by its word', async () => {
    const user = userEvent.setup()
    const w = rawWorld()
    w.rawError = { status: 404, code: 'STATEMENT_NOT_AVAILABLE', details: { reason: 'brand_new' } }
    mountDiagnostics(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'View raw statement' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The statement is not available (reason STATEMENT_NOT_AVAILABLE).',
    )
  })

  it('shows a refusal with its catalog text and code', async () => {
    const user = userEvent.setup()
    const w = rawWorld()
    w.rawError = {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'Only people read raw statements.',
    }
    mountDiagnostics(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'View raw statement' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not read the raw statement: Only people read raw statements. (PERMISSION_DENIED)',
    )
  })

  it('offers no raw view for a statement without a digest', async () => {
    const w = world()
    w.sessions = sessionList([
      session({
        state: 'active',
        statement: { digest: null, redacted: 'select 1', truncated: false },
      }),
    ])
    mountDiagnostics(PATH, w)
    await screen.findByText('select 1')
    expect(screen.queryByRole('button', { name: 'View raw statement' })).toBeNull()
  })
})

describe('accessibility', () => {
  it('has no axe violations with sessions, blocking and endpoints', async () => {
    const w = world()
    w.sessions = sessionList([
      session({ pid: 101, state: 'idle in transaction', transactionAgeMs: 90_000 }),
      session({
        pid: 202,
        state: 'active',
        waitEvent: { type: 'Lock', event: 'relation' },
        statement: { digest: DIGEST, redacted: 'update orders set x = 1', truncated: false },
      }),
    ])
    w.locks = lockGraph([wait()])
    mountDiagnostics(PATH, w)
    await screen.findByRole('table', {
      name: /Sessions of the application shop-api Running as app_rw/,
    })
    await screen.findByText('Blocking tree')
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations in the failed and cannot-tell states', async () => {
    const w = world()
    w.failures.set('/sessions', { status: 503, code: 'TARGET_UNAVAILABLE' })
    w.failures.set('/locks', { status: 500, code: 'INTERNAL_ERROR' })
    mountDiagnostics(PATH, w)
    await screen.findByRole('region', { name: 'Cannot tell what the target is doing' })
    await screen.findByRole('heading', { level: 3, name: 'Could not read lock waits' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
