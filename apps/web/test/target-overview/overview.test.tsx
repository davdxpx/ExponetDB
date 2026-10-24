import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  findingFixture,
  historyFixture,
  migrationStatusFixture,
  minutesAgo,
  mountApp,
  operationFixture,
  project,
  streamFixture,
  TAG,
  World,
  ZWSP,
} from './support.tsx'

// The target pages run in the shortcut and command providers of the real shell, without the rail.
vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const STAGING = 'shop/platform/staging'
const OVERVIEW = '/t/shop/platform/staging'

function readyWorld(): World {
  const world = new World()
  project(world)
  world.sample(STAGING, {
    probes: [
      {
        probe: 'simple',
        outcome: 'ok',
        durationMs: 4,
        errorClass: null,
        observedAt: new Date().toISOString(),
        tls: 'verified',
        endpoint: { id: null, kind: 'private', label: 'primary', verified: true },
      },
      {
        probe: 'extended',
        outcome: 'ok',
        durationMs: 5,
        errorClass: null,
        observedAt: new Date().toISOString(),
        tls: 'verified',
        endpoint: { id: null, kind: 'private', label: 'primary', verified: true },
      },
    ],
  })
  world.history = historyFixture()
  world.findings = [findingFixture()]
  world.migrations = migrationStatusFixture()
  world.stream = streamFixture()
  world.operations = [operationFixture()]
  return world
}

async function block(name: string) {
  const el = await waitFor(() => {
    const found = document.querySelector(`[data-block="${name}"]`)
    if (found === null) throw new Error(`no block ${name}`)
    return found as HTMLElement
  })
  return el
}

describe('the overview: every block of a healthy staging target', () => {
  it('shows health in incident order, the history, the migration head, operations and findings', async () => {
    mountApp(OVERVIEW, readyWorld())
    const health = await block('health')
    const groups = await within(health).findAllByRole('heading', { level: 3 })
    expect(groups.map((g) => g.textContent)).toEqual([
      'Can we reach it',
      'Does it answer correctly',
      'Is anything stuck or about to break',
    ])
    // Source and age on the state.
    expect(within(health).getByText('Sampled')).toBeInTheDocument()
    expect(within(health).getAllByText(/ago|just now|now/i).length).toBeGreaterThan(0)
    // The second and third questions have no probe in the sample: not observed, never fine.
    const stuck = health.querySelector('[data-group="stuck"]')
    expect(stuck).toHaveAttribute('data-verdict', 'not_observed')
    expect(health.querySelector('[data-group="path"]')).toHaveAttribute('data-verdict', 'ok')

    const history = await block('history')
    expect(
      await within(history).findByRole('table', { name: 'Stretches without samples' }),
    ).toBeInTheDocument()

    const migrations = await block('migrations')
    expect(await within(migrations).findByText('1 applied')).toBeInTheDocument()
    expect(within(migrations).getByText('1 pending')).toBeInTheDocument()

    const operations = await block('operations')
    expect(
      await within(operations).findByRole('table', { name: 'Recent operations on this target' }),
    ).toBeInTheDocument()
    const findings = await block('findings')
    expect(
      await within(findings).findByRole('table', { name: 'Open findings' }),
    ).toBeInTheDocument()
  })

  it('draws the gap with its cause and does not claim a sample inside it', async () => {
    mountApp(OVERVIEW, readyWorld())
    const history = await block('history')
    const gaps = await within(history).findByRole('table', { name: 'Stretches without samples' })
    expect(gaps.textContent).toContain('ExponetDB was down (no live process or worker)')
    expect(gaps.textContent).toContain('no live worker')
    expect(history.querySelector('[data-slot="no-gaps"]')).toBeNull()
  })

  it('offers the chart as a data table, with the gap and its cause in it, not a value', async () => {
    const user = userEvent.setup()
    mountApp(OVERVIEW, readyWorld())
    const history = await block('history')
    const toggles = await within(history).findAllByRole('button', { name: 'Show data as table' })
    for (const toggle of toggles) await user.click(toggle)
    const regions = within(history).getAllByRole('region', { name: /data table/ })
    const text = regions.map((r) => r.textContent ?? '').join('\n')
    expect(text).toContain('ExponetDB was down (no live process or worker)')
  })

  it('says when there is no gap, and when gaps are cut off', async () => {
    const world = readyWorld()
    world.history = historyFixture({ gaps: [] })
    mountApp(OVERVIEW, world)
    const history = await block('history')
    expect(await within(history).findByText(/No gap longer than 30 seconds/)).toBeInTheDocument()
    cleanup()
    const cut = readyWorld()
    cut.history = historyFixture({ gapsTruncated: true })
    mountApp(OVERVIEW, cut)
    const again = await block('history')
    expect(
      (await within(again).findAllByText(/More gaps exist than one read returns/)).length,
    ).toBeGreaterThan(0)
  })

  it('asks for the range chosen and shows an empty history only after a successful read', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    world.history = historyFixture({ buckets: [], gaps: [], firstSampleAt: null })
    mountApp(OVERVIEW, world)
    const history = await block('history')
    expect(await within(history).findByText('No sample in this range')).toBeInTheDocument()
    expect(within(history).getByText(/That is not the same as healthy/)).toBeInTheDocument()
    await user.click(within(history).getByRole('button', { name: 'Last 7 days' }))
    await waitFor(() =>
      expect(world.requests.filter((r) => r.includes('/health/history')).length).toBeGreaterThan(1),
    )
  })
})

describe('the overview: unknown is never green', () => {
  it('shows an unknown sample as unknown with its reason, and no group as ok', async () => {
    const world = readyWorld()
    world.sample(STAGING, {
      state: 'unknown',
      unknownBecause: 'sampler_lagging',
      probes: [
        {
          probe: 'simple',
          outcome: 'ok',
          durationMs: 4,
          errorClass: null,
          observedAt: new Date().toISOString(),
          tls: 'verified',
          endpoint: { id: null, kind: 'private', label: 'primary', verified: true },
        },
      ],
    })
    mountApp(OVERVIEW, world)
    const health = await block('health')
    await within(health).findByText('Why it is unknown:')
    expect(health.querySelector('[data-health="healthy"]')).toBeNull()
    expect(health.querySelector('[data-state-of-target="unknown"]')).not.toBeNull()
    expect(health.querySelector('[data-verdict="ok"]')).toBeNull()
    expect(health.querySelector('[data-health="unknown"]')).not.toBeNull()
  })

  it('shows an unreachable sample as unreachable with a problem on the first question', async () => {
    const world = readyWorld()
    world.sample(STAGING, {
      state: 'unreachable',
      probes: [
        {
          probe: 'simple',
          outcome: 'timeout',
          durationMs: null,
          errorClass: null,
          observedAt: new Date().toISOString(),
          tls: 'not_reached',
          endpoint: { id: null, kind: 'private', label: 'primary', verified: false },
        },
      ],
      conditions: [
        {
          condition: 'probe_simple_failed',
          severity: 'critical',
          count: null,
          observedAt: new Date().toISOString(),
        },
      ],
    })
    mountApp(OVERVIEW, world)
    const health = await block('health')
    await within(health).findByText('Timed out')
    expect(health.querySelector('[data-group="path"]')).toHaveAttribute('data-verdict', 'problem')
    expect(within(health).getAllByText('Unreachable').length).toBeGreaterThan(0)
  })
})

describe('the overview: each block reads and fails on its own', () => {
  it('shows a failed health read as failed while the other blocks still show', async () => {
    const world = readyWorld()
    world.failuresExact.set('/api/v1/targets/shop%2Fplatform%2Fstaging/health', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The sampler store did not answer.',
    })
    mountApp(OVERVIEW, world)
    const health = await block('health')
    expect(
      await within(health).findByText(/The sampler store did not answer\./),
    ).toBeInTheDocument()
    expect(
      within(health).getByText(/This does not mean there is no target health/),
    ).toBeInTheDocument()
    expect(health.querySelector('[data-group]')).toBeNull()
    const findings = await block('findings')
    expect(
      await within(findings).findByRole('table', { name: 'Open findings' }),
    ).toBeInTheDocument()
  })

  it.each([
    ['history', '/health/history', 'No sample in this range'],
    ['findings', '/findings', 'The read succeeded and found no open finding.'],
    ['operations', '/operations', 'The read succeeded and found no operation on this target.'],
  ])('shows a failed %s read as failed, never as its empty text', async (name, path, emptyText) => {
    const world = readyWorld()
    world.failures.set(path, { status: 503, code: 'UNAVAILABLE', message: 'Not reachable now.' })
    mountApp(OVERVIEW, world)
    const el = await block(name)
    expect(await within(el).findByText(/Not reachable now\./)).toBeInTheDocument()
    expect(within(el).queryByText(emptyText)).toBeNull()
  })

  it('shows a failed migration status and a failed stream separately', async () => {
    const world = readyWorld()
    world.failures.set('staging/migrations', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Ledger read failed.',
    })
    mountApp(OVERVIEW, world)
    const el = await block('migrations')
    expect(await within(el).findByText(/Ledger read failed\./)).toBeInTheDocument()
    // The stream (from mirrors) still shows.
    expect(
      await within(el).findByRole('table', { name: 'State of each bundle per environment' }),
    ).toBeInTheDocument()
    expect(el.textContent).not.toContain('No migration is applied')
  })

  it('shows a failed stream as failed while the target status shows', async () => {
    const world = readyWorld()
    world.failures.set('/projects/', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Mirror read failed.',
    })
    mountApp(OVERVIEW, world)
    const el = await block('migrations')
    expect(await within(el).findByText(/Mirror read failed\./)).toBeInTheDocument()
    expect(await within(el).findByText('1 applied')).toBeInTheDocument()
    expect(within(el).queryByText(/The project has no bundle/)).toBeNull()
  })

  it('shows empty lists only after a successful read', async () => {
    const world = readyWorld()
    world.findings = []
    world.operations = []
    world.stream = streamFixture({ bundles: [], bundleCount: 0, heads: [] })
    world.migrations = migrationStatusFixture({ applied: [], pending: [] })
    mountApp(OVERVIEW, world)
    const findings = await block('findings')
    expect(
      await within(findings).findByText('The read succeeded and found no open finding.'),
    ).toBeInTheDocument()
    const operations = await block('operations')
    expect(
      await within(operations).findByText(
        'The read succeeded and found no operation on this target.',
      ),
    ).toBeInTheDocument()
    const migrations = await block('migrations')
    expect(
      await within(migrations).findByText('The project has no bundle in its stream yet.'),
    ).toBeInTheDocument()
    expect(
      within(migrations).getByText('No migration is applied on this target.'),
    ).toBeInTheDocument()
    expect(
      within(migrations).getByText('No bundle is pending for this target.'),
    ).toBeInTheDocument()
  })

  it('names what is missing from a partial read (more findings, more operations, a cut-off stream)', async () => {
    const world = readyWorld()
    world.findingsNext = 'next'
    world.operationsNext = 'next'
    world.stream = streamFixture({ truncated: true })
    mountApp(OVERVIEW, world)
    const findings = await block('findings')
    expect(
      await within(findings).findByText(/More findings exist than one read returns/),
    ).toBeInTheDocument()
    const operations = await block('operations')
    expect(
      await within(operations).findByText(/More operations exist than one read returns/),
    ).toBeInTheDocument()
    const migrations = await block('migrations')
    expect(
      await within(migrations).findByText(/The stream is longer than one read returns/),
    ).toBeInTheDocument()
  })

  it('shows an old sample as stale with a refresh, not as current', async () => {
    const world = readyWorld()
    world.sample(STAGING, { observedAt: minutesAgo(30) })
    mountApp(OVERVIEW, world)
    const health = await block('health')
    expect(await within(health).findByRole('button', { name: /Refresh/ })).toBeInTheDocument()
    expect(health.querySelector('[data-state="stale"]')).not.toBeNull()
  })

  it('shows loading while a block waits', async () => {
    const world = readyWorld()
    let release: () => void = () => {}
    world.delays.set(
      '/findings',
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    mountApp(OVERVIEW, world)
    const findings = await block('findings')
    expect(await within(findings).findByRole('status')).toBeInTheDocument()
    expect(within(findings).queryByRole('table')).toBeNull()
    release()
    expect(
      await within(findings).findByRole('table', { name: 'Open findings' }),
    ).toBeInTheDocument()
  })
})

describe('the migration matrix on the overview', () => {
  it('shows unknown for an environment without a mirror, never "not applied", and marks this target', async () => {
    mountApp(OVERVIEW, readyWorld())
    const migrations = await block('migrations')
    const table = await within(migrations).findByRole('table', {
      name: 'State of each bundle per environment',
    })
    const production = within(table)
      .getAllByRole('cell')
      .filter((c) => c.getAttribute('data-env') === 'production')
    expect(production.map((c) => c.textContent)).toEqual(['Unknown', 'Unknown'])
    expect(within(table).getByText('This target')).toBeInTheDocument()
    expect(
      within(table).getAllByText('The mirror of this environment has not been read yet.').length,
    ).toBe(1)
    // The one cell that says "Not applied" is staging's own mirror cell.
    expect(within(table).getAllByText('Not applied')).toHaveLength(1)
    expect(within(table).getByText(/Checksum differs/)).toBeInTheDocument()
  })
})

describe('the production cue', () => {
  it('shows the tier of a production target in the header, without a frame', async () => {
    const world = readyWorld()
    world.sample('shop/platform/production')
    mountApp('/t/shop/platform/production', world)
    await block('health')
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'production',
      ),
    )
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
  })
})

describe('hostile content', () => {
  it('shows names, summaries, endpoint labels and codes as text with visible code points', async () => {
    const world = readyWorld()
    world.findings = [
      findingFixture({
        code: `CODE${BIDI}X`,
        summary: `<script>alert(1)</script> ${BIDI}evil ${ZWSP} ${TAG} <img src=x onerror=alert(1)>`,
      }),
    ]
    world.operations = [operationFixture({ kind: `migration.apply${BIDI}` as never })]
    world.sample(STAGING, {
      probes: [
        {
          probe: 'simple',
          outcome: 'ok',
          durationMs: 1,
          errorClass: null,
          observedAt: new Date().toISOString(),
          tls: 'verified',
          endpoint: { id: null, kind: 'private', label: `pri${BIDI}mary`, verified: true },
        },
      ],
      conditions: [
        {
          condition: `strange${BIDI}`,
          severity: 'warning',
          count: 2,
          observedAt: new Date().toISOString(),
        },
      ],
    })
    const migration = migrationStatusFixture()
    world.migrations = {
      ...migration,
      pending: [
        {
          migrationId: '01M4S9000000000000000000A2',
          name: `x${BIDI}y`,
          checksum: `sha256:c1:${'cd'.repeat(32)}`,
        },
      ],
    }
    mountApp(OVERVIEW, world)
    const findings = await block('findings')
    await within(findings).findByRole('table', { name: 'Open findings' })
    const text = document.body.textContent ?? ''
    expect(text).toContain('⟨U+202E⟩')
    expect(text).toContain('<script>alert(1)</script>')
    expect(text).not.toContain(BIDI)
    expect(text).not.toContain(ZWSP)
    expect(text).not.toContain(TAG)
    expect(document.querySelector('script:not([src])')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    const health = await block('health')
    expect(health.textContent).toContain('⟨U+202E⟩')
    expect(health.textContent).toContain('A condition this page does not know')
  })
})

describe('accessibility', () => {
  it('has no axe violations on the ready page', async () => {
    mountApp(OVERVIEW, readyWorld())
    const findings = await block('findings')
    await within(findings).findByRole('table', { name: 'Open findings' })
    await within(await block('migrations')).findByRole('table', {
      name: 'State of each bundle per environment',
    })
    await within(await block('history')).findByRole('table', { name: 'Stretches without samples' })
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations when every block failed', async () => {
    const world = readyWorld()
    world.failures.set('/findings', { status: 500, code: 'INTERNAL_ERROR' })
    world.failures.set('/operations', { status: 500, code: 'INTERNAL_ERROR' })
    world.failures.set('/health/history', { status: 500, code: 'INTERNAL_ERROR' })
    world.failures.set('/migrations', { status: 500, code: 'INTERNAL_ERROR' })
    world.failures.set('/projects/', { status: 500, code: 'INTERNAL_ERROR' })
    mountApp(OVERVIEW, world)
    await within(await block('findings')).findByRole('alert')
    await within(await block('operations')).findByRole('alert')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
