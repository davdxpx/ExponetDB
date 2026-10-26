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
  operationFixture,
  World,
} from './support.tsx'

afterEach(cleanup)

/** A key-number card: a link while it is counted, named by its label first. */
const kpiList = (): HTMLElement => screen.getByRole('list', { name: 'Key numbers' })
const kpi = (label: string): HTMLElement =>
  within(kpiList()).getByRole('link', { name: new RegExp(`^${label}`) })
const findKpi = async (label: string): Promise<HTMLElement> =>
  within(await screen.findByRole('list', { name: 'Key numbers' })).getByRole('link', {
    name: new RegExp(`^${label}`),
  })
const kpiItem = (id: string): HTMLElement =>
  document.querySelector(`[data-kpi="${id}"]`) as HTMLElement

describe('the fleet overview', () => {
  it('shows each key number as one card that is a link to the list that explains it', async () => {
    const world = new World()
    mountApp('/', world)
    const databases = await findKpi('Databases')
    expect(databases).toHaveAttribute('href', '/targets')
    expect(databases.textContent).toContain('7')
    expect(databases.textContent).toContain('3 production · 4 non-production')
    expect(kpi('Critical findings')).toHaveAttribute('href', '/findings?severity=critical')
    expect(kpi('Critical findings').textContent).toContain('Of 9 open findings')
    expect(kpi('Needs attention')).toHaveAttribute(
      'href',
      '/changes/operations?state=needs_attention',
    )
    expect(kpi('Awaiting approval')).toHaveAttribute('href', '/approvals')
    expect(kpi('Running')).toHaveAttribute('href', '/changes/operations?state=running')
    // A card is one link with nothing interactive inside, so it is reached once and opens in a
    // new tab like any link; there is no separate underlined word at its foot.
    for (const id of ['targets', 'critical', 'attention', 'approval', 'running']) {
      const item = kpiItem(id)
      expect(within(item).getAllByRole('link')).toHaveLength(1)
      expect(item.querySelector('a a, a button')).toBeNull()
    }
    // Where the counts came from is said once, not on every card.
    expect(document.querySelector('[data-fleet-as-of]')?.textContent).toContain(
      'Counted by the server from sampled data',
    )
    // One request each, however many targets there are: no read per target. The worst targets
    // come from one list read (the one the Databases page shares), never from a read per row.
    expect(world.gets('/api/v1/fleet')).toHaveLength(1)
    expect(world.apiRequests.every((r) => !/\/targets\/[^?]/.test(r.path))).toBe(true)
    await screen.findByText('Targets that need attention')
    expect(world.gets('/api/v1/targets')).toHaveLength(1)
  })

  it('makes a non-zero count of work for a person loud and leaves zero quiet', async () => {
    const world = new World()
    world.fleet = fleetFixture({
      operations: {
        available: true,
        awaiting_approval: 0,
        running: 2,
        needs_attention: 3,
        lowerBound: false,
        lowerBoundReason: null,
        observedAt: iso(),
        source: 'live',
      },
    })
    mountApp('/', world)
    await findKpi('Databases')
    expect(kpi('Critical findings')).toHaveAttribute('data-tone', 'critical')
    expect(kpi('Needs attention')).toHaveAttribute('data-tone', 'critical')
    expect(kpi('Awaiting approval')).toHaveAttribute('data-tone', 'neutral')
    expect(kpi('Running')).toHaveAttribute('data-tone', 'info')
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
    expect((await findKpi('Databases')).textContent).toContain('At least 1,000')
    expect(screen.getByText('The list is bounded at 1000 targets.')).toBeInTheDocument()
    expect(kpi('Running').textContent).toContain('At least 50')
    expect(screen.getAllByText('Only the newest 50 operations were counted.')).toHaveLength(3)
    // The health counts of a bounded fleet are floors too.
    const health = screen.getByRole('list', { name: 'Targets by health state' })
    expect(within(health).getAllByText(/^At least/)).not.toHaveLength(0)
  })

  it('renders an unavailable findings part with its reason as a plain card, never as zero or a link', async () => {
    const world = new World()
    world.fleet = fleetFixture({ findings: { available: false, reason: 'permission_denied' } })
    mountApp('/', world)
    const findings = await screen.findByRole('group', { name: 'Critical findings' })
    expect(findings.textContent).toContain(
      'You do not have permission to see this part. It is not zero.',
    )
    expect(findings.textContent).toContain('permission_denied')
    expect(findings).toHaveAttribute('data-part', 'unavailable')
    expect(within(findings).queryByText('0')).toBeNull()
    expect(within(kpiItem('critical')).queryByRole('link')).toBeNull()
    // The other parts are still counted, and the severity meter is not drawn from nothing.
    expect(kpi('Running').textContent).toContain('2')
    expect(document.querySelector('[data-severity-meter]')).toBeNull()
  })

  it('renders an unavailable operations part with its reason, never as zero', async () => {
    const world = new World()
    world.fleet = fleetFixture({ operations: { available: false, reason: 'store_unavailable' } })
    mountApp('/', world)
    await screen.findByRole('group', { name: 'Awaiting approval' })
    for (const name of ['Awaiting approval', 'Running', 'Needs attention']) {
      const card = screen.getByRole('group', { name })
      expect(card).toHaveAttribute('data-part', 'unavailable')
      expect(card.textContent).toContain('The server could not count this part. It is not zero.')
      expect(within(card).queryByText('0')).toBeNull()
      expect(within(card).queryByRole('link')).toBeNull()
    }
  })

  it('names backup health as not observed yet in its own small slot, with no number', async () => {
    mountApp('/', new World())
    const slot = (await screen.findByRole('heading', { name: 'Backups' })).closest(
      '[data-slot="fleet-backups"]',
    ) as HTMLElement
    expect(within(slot).getByText('Backup health is not observed yet')).toBeInTheDocument()
    expect(slot.textContent).toMatch(/Backup health arrives with Wave 9/)
    expect(slot.textContent).not.toMatch(/[0-9]+ (backups?|at risk)/)
  })

  it('shows a part counted long ago as stale, on that card only', async () => {
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
    await findKpi('Awaiting approval')
    expect(kpi('Awaiting approval').querySelector('[data-stale]')).toHaveTextContent(/Out of date/)
    expect(kpi('Databases').querySelector('[data-stale]')).toBeNull()
  })

  it('never shows unknown targets as healthy, and links each state to the filtered list', async () => {
    mountApp('/', new World())
    const states = await screen.findByRole('list', { name: 'Targets by health state' })
    const unknown = states.querySelector('[data-health-row="unknown"]') as HTMLElement
    expect(within(unknown).getByText('Unknown')).toBeInTheDocument()
    expect(unknown.querySelector('[data-health="unknown"]')).not.toBeNull()
    expect(unknown.querySelector('[data-health="healthy"]')).toBeNull()
    expect(
      within(unknown).getByRole('link', { name: 'Show the 2 unknown targets' }),
    ).toHaveAttribute('href', '/targets?health=unknown')
    // The bar is as wide per state as its share; unknown is its own segment.
    const bar = screen.getByRole('img', { name: /^Targets by health:/ })
    expect(bar.getAttribute('aria-label')).toBe(
      'Targets by health: 1 unhealthy, 1 degraded, 2 unknown, 3 healthy',
    )
    expect(bar.querySelector('[data-health-segment="unknown"]')).not.toBeNull()
    expect(bar.querySelector('[data-health-segment="unreachable"]')).toBeNull()
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
    expect(screen.queryByRole('list', { name: 'Key numbers' })).toBeNull()
    expect(screen.queryByRole('list', { name: 'Targets by health state' })).toBeNull()
  })

  it('shows the loading state while the fleet is being read', async () => {
    const world = new World()
    let release: () => void = () => {}
    world.delays.set('/api/v1/fleet', new Promise<void>((resolve) => (release = resolve)))
    mountApp('/', world)
    expect(await screen.findAllByText(/Loading/)).not.toHaveLength(0)
    expect(screen.queryByRole('list', { name: 'Key numbers' })).toBeNull()
    release()
    expect(await findKpi('Databases')).toBeInTheDocument()
  })

  it('reads every part again on Refresh', async () => {
    const world = new World()
    mountApp('/', world)
    await findKpi('Databases')
    await screen.findByText('Targets that need attention')
    const before = world.gets('/api/v1/fleet').length
    screen.getByRole('button', { name: 'Refresh' }).click()
    await findKpi('Databases')
    await expect.poll(() => world.gets('/api/v1/fleet').length).toBeGreaterThan(before)
  })
})

describe('the open findings by severity', () => {
  it('splits the open findings by severity from the counts, each severity a link to its list', async () => {
    const world = new World()
    mountApp('/', world)
    const meter = await screen.findByRole('img', { name: '2 critical, 3 warning, 4 info' })
    expect(meter.querySelectorAll('[data-severity-segment]')).toHaveLength(3)
    expect(screen.getByRole('link', { name: 'Show the 3 warning findings' })).toHaveAttribute(
      'href',
      '/findings?severity=warning',
    )
    // Counting costs the fleet read only: the page never lists findings to aggregate them.
    expect(world.gets('/api/v1/findings').every((r) => r.path.includes('limit=5'))).toBe(true)
    expect(
      screen.getByText(/needs a summary read the server does not offer yet/),
    ).toBeInTheDocument()
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
    // The whole row is the link; a long summary is cut without a button inside it.
    expect(link.querySelector('a, button')).toBeNull()
    expect(link).toHaveAccessibleDescription('The schema differs from the baseline.')
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
    const list = await screen.findByRole('list', { name: 'Newest open critical findings' })
    expect(within(list).queryByRole('link')).toBeNull()
    expect(list.textContent).toContain('⟨U+202E⟩')
    expect(list.textContent).not.toContain(BIDI)
    expect(list.querySelector('script')).toBeNull()
    expect(list.textContent).toContain('<script>window.__x = 1</script>')
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
    expect(await findKpi('Databases')).toBeInTheDocument()
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
    const list = await screen.findByRole('list', { name: 'Control Plane components' })
    expect(within(list).getByText('control-store')).toBeInTheDocument()
    expect(within(list).getByText('live')).toBeInTheDocument()
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
    expect(screen.queryByRole('list', { name: 'Control Plane components' })).toBeNull()
  })
})

describe('accessibility', () => {
  it('has no violations with every card, the findings and the Control Plane read', async () => {
    const world = new World()
    world.findings = [findingFixture('shop/platform/production')]
    world.controlPlane = healthFixture({ unobserved: [{ component: 'worker', reason: 'None.' }] })
    mountApp('/', world)
    world.operations = [operationFixture()]
    await screen.findByRole('list', { name: 'Control Plane components' })
    await screen.findByRole('list', { name: 'Newest open critical findings' })
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no violations when the parts are unavailable', async () => {
    const world = new World()
    world.fleet = fleetFixture({
      findings: { available: false, reason: 'permission_denied' },
      operations: { available: false, reason: 'permission_denied' },
    })
    mountApp('/', world)
    await screen.findByRole('group', { name: 'Critical findings' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the operations that need a person', () => {
  it('lists them newest first, each row a link to its operation page', async () => {
    const world = new World()
    world.operations = [operationFixture()]
    mountApp('/', world)
    const link = await screen.findByRole('link', {
      name: 'Open operation op_01M4S9000000000000000000Q1',
    })
    expect(link).toHaveAttribute('href', '/changes/operations/op_01M4S9000000000000000000Q1')
    expect(link.textContent).toContain('migration.apply')
    expect(link.textContent).toContain('shop/platform/production')
    expect(link.querySelector('a, button')).toBeNull()
    const request = world.gets('/api/v1/operations')[0]?.path ?? ''
    expect(request).toContain('state=needs_attention')
    expect(request).toContain('limit=5')
  })

  it('says none needs attention only after a successful read (empty)', async () => {
    mountApp('/', new World())
    expect(
      await screen.findByText('The read succeeded and no operation needs attention.'),
    ).toBeInTheDocument()
  })

  it('shows a failed read as failed, never as no operation', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/operations', {
      status: 500,
      code: 'INTERNAL',
      message: 'Operations could not be listed.',
    })
    mountApp('/', world)
    expect(await screen.findByText('Operations could not be listed.')).toBeInTheDocument()
    expect(screen.queryByText('The read succeeded and no operation needs attention.')).toBeNull()
  })

  it('names what is missing when more operations need attention than the list shows', async () => {
    const world = new World()
    world.operations = [operationFixture()]
    world.operationsNextCursor = 'next'
    mountApp('/', world)
    expect(
      await screen.findByText(/More operations need attention than this list shows/),
    ).toBeInTheDocument()
  })
})
