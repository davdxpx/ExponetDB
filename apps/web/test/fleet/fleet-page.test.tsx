import '@testing-library/jest-dom/vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  findingFixture,
  fleetFixture,
  healthFixture,
  iso,
  mountApp,
  World,
} from './support.tsx'

afterEach(cleanup)

const card = (name: string): HTMLElement => screen.getByRole('group', { name })

describe('the fleet overview', () => {
  it('shows each count with its source and age, and links the lists that explain them', async () => {
    const world = new World()
    mountApp('/', world)
    const targets = await screen.findByRole('group', { name: 'Targets' })
    expect(within(targets).getByText('7')).toBeInTheDocument()
    expect(targets.textContent).toContain('3 production, 4 non-production')
    expect(targets.textContent).toContain('2 decommissioned, counted apart')
    expect(targets.textContent).toContain('Health read from 4 sampled, 1 cached, 2 inferred')
    expect(targets.textContent).toContain('Source:')
    expect(targets.textContent).toContain('sampled')
    expect(within(targets).getByRole('link', { name: 'Databases' })).toHaveAttribute(
      'href',
      '/targets',
    )
    expect(card('Open findings').textContent).toContain('2 critical, 3 warning, 4 info')
    expect(
      within(card('Awaiting approval')).getByRole('link', { name: 'Open the approvals queue' }),
    ).toHaveAttribute('href', '/approvals')
    expect(
      within(card('Running')).getByRole('link', { name: 'Show running operations' }),
    ).toHaveAttribute('href', '/changes/operations?state=running')
    expect(
      within(card('Needs attention')).getByRole('link', {
        name: 'Show operations that need attention',
      }),
    ).toHaveAttribute('href', '/changes/operations?state=needs_attention')
    // One request each, however many targets there are: no read per target. The worst targets
    // come from one list read (the one the Databases page shares), never from a read per row.
    expect(world.gets('/api/v1/fleet')).toHaveLength(1)
    expect(world.apiRequests.every((r) => !/\/targets\/[^?]/.test(r.path))).toBe(true)
    await screen.findByText('Targets that need attention')
    expect(world.gets('/api/v1/targets')).toHaveLength(1)
  })

  it('says "at least N" when the server marks a count as a lower bound, with its reason', async () => {
    const world = new World()
    const base = fleetFixture()
    world.fleet = fleetFixture({
      targets: {
        ...base.targets,
        total: 1000,
        lowerBound: true,
        lowerBoundReason: 'The list is bounded at 1000 targets.',
      },
      operations: {
        available: true,
        awaiting_approval: 1,
        running: 50,
        needs_attention: 0,
        lowerBound: true,
        lowerBoundReason: 'Only the newest 50 operations were counted.',
        observedAt: iso(),
        source: 'live',
      },
    })
    mountApp('/', world)
    expect(await screen.findByText('At least 1000')).toBeInTheDocument()
    expect(screen.getByText('The list is bounded at 1000 targets.')).toBeInTheDocument()
    expect(within(card('Running')).getByText('At least 50')).toBeInTheDocument()
    expect(screen.getAllByText('Only the newest 50 operations were counted.')).toHaveLength(3)
    // The health counts of a bounded fleet are floors too.
    expect(
      within(screen.getByRole('table', { name: 'Targets by health state' })).getAllByText(
        /^At least/,
      ),
    ).not.toHaveLength(0)
  })

  it('renders an unavailable findings part with its reason, never as zero', async () => {
    const world = new World()
    world.fleet = fleetFixture({ findings: { available: false, reason: 'permission_denied' } })
    mountApp('/', world)
    const findings = await screen.findByRole('group', { name: 'Open findings' })
    expect(findings.textContent).toContain(
      'You do not have permission to see this part. It is not zero.',
    )
    expect(findings.textContent).toContain('permission_denied')
    expect(findings).toHaveAttribute('data-part', 'unavailable')
    expect(within(findings).queryByText('0')).toBeNull()
    // The other parts are still counted.
    expect(within(card('Running')).getByText('2')).toBeInTheDocument()
  })

  it('renders an unavailable operations part with its reason, never as zero', async () => {
    const world = new World()
    world.fleet = fleetFixture({ operations: { available: false, reason: 'store_unavailable' } })
    mountApp('/', world)
    await screen.findByRole('group', { name: 'Awaiting approval' })
    for (const name of ['Awaiting approval', 'Running', 'Needs attention']) {
      expect(card(name)).toHaveAttribute('data-part', 'unavailable')
      expect(card(name).textContent).toContain(
        'The server could not count this part. It is not zero.',
      )
      expect(within(card(name)).queryByText('0')).toBeNull()
    }
  })

  it('names backups at risk as a Wave 9 state, with no number', async () => {
    mountApp('/', new World())
    expect(await screen.findByText('Backups at risk is not available yet')).toBeInTheDocument()
    expect(screen.getByText(/Backup health arrives with Wave 9/)).toBeInTheDocument()
  })

  it('shows a part counted long ago as stale', async () => {
    const world = new World()
    world.fleet = fleetFixture({
      operations: {
        available: true,
        awaiting_approval: 4,
        running: 0,
        needs_attention: 0,
        lowerBound: false,
        lowerBoundReason: null,
        observedAt: iso(30 * 60_000),
        source: 'cached',
      },
    })
    mountApp('/', world)
    await screen.findByRole('group', { name: 'Awaiting approval' })
    expect(within(card('Awaiting approval')).getByRole('status')).toHaveTextContent(/Stale/)
    expect(within(card('Targets')).queryByRole('status')).toBeNull()
  })

  it('never shows unknown targets as healthy, and links each state to the filtered list', async () => {
    mountApp('/', new World())
    const table = await screen.findByRole('table', { name: 'Targets by health state' })
    const unknown = table.querySelector('[data-health-row="unknown"]') as HTMLElement
    expect(within(unknown).getByText('Unknown')).toBeInTheDocument()
    expect(unknown.querySelector('[data-health="unknown"]')).not.toBeNull()
    expect(unknown.querySelector('[data-health="healthy"]')).toBeNull()
    expect(within(unknown).getByRole('link', { name: 'Show unknown targets' })).toHaveAttribute(
      'href',
      '/targets?health=unknown',
    )
    expect(screen.getByText(/Unknown means no recent sample/)).toBeInTheDocument()
  })

  it('shows a failed fleet read as an error and not as empty cards', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/fleet', {
      status: 500,
      code: 'INTERNAL',
      message: 'The store did not answer.',
    })
    mountApp('/', world)
    expect(await screen.findByText(/Could not read Fleet overview/)).toBeInTheDocument()
    expect(screen.getByText(/This does not mean there is no Fleet overview/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Targets' })).toBeNull()
    expect(screen.queryByRole('table', { name: 'Targets by health state' })).toBeNull()
  })

  it('shows the loading state while the fleet is being read', async () => {
    const world = new World()
    let release: () => void = () => {}
    world.delays.set('/api/v1/fleet', new Promise<void>((resolve) => (release = resolve)))
    mountApp('/', world)
    expect(await screen.findAllByText(/Loading/)).not.toHaveLength(0)
    expect(screen.queryByRole('group', { name: 'Targets' })).toBeNull()
    release()
    expect(await screen.findByRole('group', { name: 'Targets' })).toBeInTheDocument()
  })
})

describe('the newest critical findings', () => {
  it('lists them with a link to the findings page of the target', async () => {
    const world = new World()
    world.findings = [findingFixture('shop/platform/production')]
    mountApp('/', world)
    const link = await screen.findByRole('link', {
      name: 'Open the findings of shop/platform/production',
    })
    expect(link).toHaveAttribute('href', '/t/shop/platform/production/findings')
    const request = world.gets('/api/v1/findings')[0]?.path ?? ''
    expect(request).toContain('severity=critical')
    expect(request).toContain('state=open')
  })

  it('shows a target path it cannot link as marked text, not as a link', async () => {
    const world = new World()
    world.findings = [
      findingFixture(`../admin${BIDI}/x`, {
        id: 'fnd_01M4S9000000000000000000A2',
        summary: '<script>window.__x = 1</script> [click](https://evil.example)',
      }),
    ]
    mountApp('/', world)
    const table = await screen.findByRole('table', { name: 'Newest open critical findings' })
    expect(within(table).queryByRole('link')).toBeNull()
    expect(table.textContent).toContain('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
    expect(table.querySelector('script')).toBeNull()
    expect(table.textContent).toContain('<script>window.__x = 1</script>')
  })

  it('says that no critical finding is open only after a successful read', async () => {
    mountApp('/', new World())
    expect(
      await screen.findByText('The read succeeded and no critical finding is open.'),
    ).toBeInTheDocument()
  })

  it('shows a failed findings read as failed, not as none', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/findings', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'You may not read findings.',
    })
    mountApp('/', world)
    expect(await screen.findByText('You may not read findings.')).toBeInTheDocument()
    expect(screen.queryByText('The read succeeded and no critical finding is open.')).toBeNull()
    // The counts above are unaffected.
    expect(await screen.findByRole('group', { name: 'Targets' })).toBeInTheDocument()
  })

  it('names what is missing when more findings exist than the list shows', async () => {
    const world = new World()
    world.findings = [findingFixture('shop/platform/production')]
    world.findingsNextCursor = 'next'
    mountApp('/', world)
    expect(
      await screen.findByText(/More critical findings exist than this list shows/),
    ).toBeInTheDocument()
  })
})

describe('the Control Plane health', () => {
  it('lists the components with state, source and age', async () => {
    mountApp('/', new World())
    const table = await screen.findByRole('table', { name: 'Control Plane components' })
    expect(within(table).getByText('control-store')).toBeInTheDocument()
    expect(within(table).getByText('live')).toBeInTheDocument()
    expect(screen.getByText('Overall: Operational')).toBeInTheDocument()
  })

  it('lists unobserved components as not observed, never green', async () => {
    const world = new World()
    world.controlPlane = healthFixture({
      unobserved: [
        { component: 'audit-export', reason: 'No export is configured.' },
        { component: `worker${BIDI}`, reason: 'No heartbeat was received.' },
      ],
    })
    mountApp('/', world)
    const box = await screen.findByText('Not observed')
    const region = box.closest('[data-unobserved]') as HTMLElement
    expect(region.querySelectorAll('[data-health="unknown"]')).toHaveLength(2)
    expect(region.querySelector('[data-health="healthy"]')).toBeNull()
    expect(region.textContent).toContain('audit-export')
    expect(region.textContent).toContain('⟨U+202E⟩')
    // The partial banner names the same components as missing.
    expect(screen.getAllByText(/audit-export/).length).toBeGreaterThan(1)
  })

  it('shows a failed read as failed', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/installation/health', {
      status: 500,
      code: 'INTERNAL',
      message: 'Health is unavailable.',
    })
    mountApp('/', world)
    expect(await screen.findByText('Health is unavailable.')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Control Plane components' })).toBeNull()
  })
})

describe('accessibility', () => {
  it('has no violations with every card, the findings and the Control Plane read', async () => {
    const world = new World()
    world.findings = [findingFixture('shop/platform/production')]
    world.controlPlane = healthFixture({ unobserved: [{ component: 'worker', reason: 'None.' }] })
    mountApp('/', world)
    await screen.findByRole('table', { name: 'Control Plane components' })
    await screen.findByRole('table', { name: 'Newest open critical findings' })
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no violations when the parts are unavailable', async () => {
    const world = new World()
    world.fleet = fleetFixture({
      findings: { available: false, reason: 'permission_denied' },
      operations: { available: false, reason: 'permission_denied' },
    })
    mountApp('/', world)
    await screen.findByRole('group', { name: 'Open findings' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
