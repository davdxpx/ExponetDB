import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  AGO,
  BIDI,
  HOSTILE,
  ledgerEntry,
  ledgerStatus,
  mountOps,
  must,
  nth,
  OpsWorld,
  plan,
  project,
  report,
  stream,
  TARGET,
  ulid,
  withDefaults,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PAGE = `/t/${TARGET}/migrations`
const LEDGER = /\/api\/v1\/targets\/shop%2Fplatform%2Fstaging\/migrations$/

function world(): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET)
  return withDefaults(w)
}

async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name })
  const root = heading.closest('[data-slot="page-section"]')
  if (!(root instanceof HTMLElement)) throw new Error(`no section ${name}`)
  return root
}

describe('the migrations page: ledger', () => {
  it('lists the applied migrations with checksum, time, operation link and verification', async () => {
    mountOps(PAGE, world())
    const ledger = await section('Ledger')
    const table = await within(ledger).findByRole('table', {
      name: 'Applied migrations of this target',
    })
    expect(within(table).getByText('add_orders_1')).toBeInTheDocument()
    expect(table.textContent).toContain(`sha256:c1:${'1'.padStart(64, 'a')}`.slice(0, 20))
    // Verified and pending are different words, not colors.
    expect(within(table).getByText(/^Verified/)).toBeInTheDocument()
    expect(within(table).getByText('Verification pending')).toBeInTheDocument()
    expect(within(table).getAllByRole('link', { name: 'View operation' })[0]).toHaveAttribute(
      'href',
      `/changes/operations/op_${ulid(1)}`,
    )
    // The pending bundles of the project.
    expect(
      within(ledger).getByRole('table', {
        name: 'Bundles of the project not yet applied to this target',
      }),
    ).toBeInTheDocument()
    expect(within(ledger).getByText('add_invoices')).toBeInTheDocument()
  })

  it('says the empty ledger only after a successful read', async () => {
    const w = world()
    w.on('GET', LEDGER, ledgerStatus({ applied: [], pending: [] }))
    mountOps(PAGE, w)
    expect(
      await screen.findByText('The read succeeded: no migration is applied to this target yet.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('The read succeeded: no bundle is pending for this target.'),
    ).toBeInTheDocument()
  })

  it('shows a failed read as failed, never as an empty ledger', async () => {
    const w = world()
    w.fail('GET', LEDGER, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    const ledger = await section('Ledger')
    expect(await within(ledger).findByText(/Could not read ledger/)).toBeInTheDocument()
    expect(within(ledger).getByText(/This does not mean there is no ledger/)).toBeInTheDocument()
    expect(within(ledger).queryByText(/no migration is applied/)).toBeNull()
  })

  it('names the missing permission instead of an empty ledger', async () => {
    const w = world()
    w.fail('GET', LEDGER, 403, 'PERMISSION_DENIED')
    mountOps(PAGE, w)
    const ledger = await section('Ledger')
    expect(await within(ledger).findByText('migrations.read')).toBeInTheDocument()
    expect(within(ledger).queryByText(/no migration is applied/)).toBeNull()
  })

  it('shows an old read as stale with its age and a refresh', async () => {
    const w = world()
    w.on('GET', LEDGER, ledgerStatus({ observedAt: AGO(3 * 3_600_000) }))
    mountOps(PAGE, w)
    const ledger = await section('Ledger')
    expect(await within(ledger).findByRole('button', { name: /Refresh/ })).toBeInTheDocument()
    expect(within(ledger).getByText('add_orders_1')).toBeInTheDocument()
  })

  it('warns when the mirror differs from the ledger and when a non-transactional bundle is incomplete', async () => {
    const w = world()
    w.on(
      'GET',
      LEDGER,
      ledgerStatus({
        mirror: { inSync: false, checkedAt: AGO(1000) },
        incompleteNontransactional: [ulid(5)],
      }),
    )
    mountOps(PAGE, w)
    expect(
      await screen.findByText('The Control Store mirror differs from the ledger'),
    ).toBeInTheDocument()
    expect(screen.getByText('A non-transactional migration did not finish')).toBeInTheDocument()
  })

  it('renders hostile names as marked text, never as markup', async () => {
    const w = world()
    w.on(
      'GET',
      LEDGER,
      ledgerStatus({
        applied: [ledgerEntry(1, { name: HOSTILE, checksum: `sha256:c1:${BIDI}x` })],
      }),
    )
    mountOps(PAGE, w)
    const ledger = await section('Ledger')
    await within(ledger).findByRole('table', { name: 'Applied migrations of this target' })
    expect(ledger.querySelector('script')).toBeNull()
    expect(ledger.textContent).toContain('⟨U+202E⟩')
    expect(ledger.textContent).not.toContain(BIDI)
  })
})

describe('the migrations page: timeline, plans and drift', () => {
  it('shows a cell with no record as unknown, never as not applied', async () => {
    mountOps(PAGE, world())
    const timeline = await section('Across environments')
    // Bundle 2 has no production cell: its production marker reads unknown.
    await within(timeline).findByText('add_orders_2')
    const unknown = within(timeline).getAllByText(/no record|unknown/i)
    expect(unknown.length).toBeGreaterThan(0)
    expect(timeline.textContent).toMatch(/shop|production/i)
  })

  it('names the environments the timeline cannot speak for', async () => {
    const w = world()
    const s = stream()
    const environments = s.environments.map((e) =>
      e.slug === 'production' ? { ...e, target: null } : e,
    )
    environments[0] = {
      ...nth(environments, 0),
      mirror: {
        ...must(nth(environments, 0).mirror),
        divergent: true,
        divergence: { missing: [ulid(1)], checksumDiffers: [], unrecorded: [] },
      },
    }
    w.on('GET', /\/api\/v1\/projects\/[^/]+\/migrations$/, { ...s, environments })
    mountOps(PAGE, w)
    const timeline = await section('Across environments')
    expect(await within(timeline).findByText(/No target you may see/)).toBeInTheDocument()
    expect(within(timeline).getByText(/1 missing, 0 with another checksum/)).toBeInTheDocument()
  })

  it('says a truncated stream is partial', async () => {
    const w = world()
    w.on(
      'GET',
      /\/api\/v1\/projects\/[^/]+\/migrations$/,
      stream({ truncated: true, bundleCount: 1500 }),
    )
    mountOps(PAGE, w)
    const timeline = await section('Across environments')
    expect(await within(timeline).findByText(/Showing part of/)).toBeInTheDocument()
  })

  it('shows a failed stream as failed', async () => {
    const w = world()
    w.fail('GET', /\/api\/v1\/projects\/[^/]+\/migrations$/, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    const timeline = await section('Across environments')
    expect(
      await within(timeline).findByText(/Could not read migration timeline/),
    ).toBeInTheDocument()
  })

  it('lists the plans for this target with a link to each review page and says when more exist', async () => {
    const w = world()
    w.on('GET', /\/api\/v1\/plans\?/, { items: [plan(1), plan(2)], nextCursor: 'more' })
    mountOps(PAGE, w)
    const plans = await section('Plans for this target')
    const table = await within(plans).findByRole('table', { name: 'Newest plans for this target' })
    expect(within(table).getByRole('link', { name: `pln_${ulid(1)}` })).toHaveAttribute(
      'href',
      `/changes/plans/pln_${ulid(1)}`,
    )
    expect(within(plans).getByText(/Showing part of/)).toBeInTheDocument()
    expect(within(plans).getByRole('link', { name: 'Open all plans' })).toHaveAttribute(
      'href',
      '/changes/plans',
    )
  })

  it('summarizes open drift findings and links to the drift page', async () => {
    const w = world()
    w.on('GET', /\/targets\/shop%2Fplatform%2Fstaging\/findings/, {
      items: [
        {
          id: `fnd_${ulid(1)}`,
          code: 'schema_drift',
          kind: 'drift',
          severity: 'critical',
          state: 'open',
          object: 'public.orders',
          summary: 's',
          firstSeenAt: AGO(1000),
          lastSeenAt: AGO(1000),
          occurrences: 1,
          resolution: null,
          resolvedAt: null,
          securityRelevant: false,
          subject: { clusterId: null, nodeId: null, targetId: null },
        },
      ],
      nextCursor: null,
    })
    mountOps(PAGE, w)
    const drift = await section('Drift findings')
    expect(await within(drift).findByText('public.orders')).toBeInTheDocument()
    expect(
      within(drift).getByRole('link', { name: /Compare expected and actual/ }),
    ).toHaveAttribute('href', `/t/${TARGET}/drift`)
  })

  it('shows the production chip on a production target', async () => {
    const w = new OpsWorld()
    project(w)
    w.sample('shop/platform/production')
    withDefaults(w, 'shop/platform/production')
    mountOps('/t/shop/platform/production/migrations', w)
    expect(await screen.findByRole('heading', { level: 1, name: /Migrations/ })).toBeInTheDocument()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'production',
      ),
    )
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
  })

  it('has no accessibility violations', async () => {
    mountOps(PAGE, world())
    await section('Ledger')
    await screen.findByRole('table', { name: 'Applied migrations of this target' })
    await screen.findAllByText('add_orders_2')
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the legacy import review', () => {
  const REPORT_PAGE = `${PAGE}?report=imr_${ulid(1)}`
  const REPORT = new RegExp(`/import-reports/imr_${ulid(1)}$`)

  it('asks for a report id and refuses anything that is not one', async () => {
    const w = world()
    mountOps(PAGE, w)
    const user = userEvent.setup()
    const import_ = await section('Legacy import')
    await user.type(within(import_).getByLabelText('Import report id'), '../x')
    await user.click(within(import_).getByRole('button', { name: 'Open report' }))
    expect(await within(import_).findByRole('alert')).toHaveTextContent('not an import report id')
    expect(w.callsTo('GET', /import-reports/)).toHaveLength(0)
  })

  it('ignores a malformed report in the address and asks for nothing', async () => {
    const w = world()
    mountOps(`${PAGE}?report=../../x`, w)
    const import_ = await section('Legacy import')
    expect(within(import_).getByLabelText('Import report id')).toBeInTheDocument()
    expect(w.callsTo('GET', /import-reports/)).toHaveLength(0)
  })

  it('shows the report: classification, evidence, undecided items; hostile names stay text', async () => {
    const w = world()
    w.on('GET', REPORT, report())
    mountOps(REPORT_PAGE, w)
    const import_ = await section('Legacy import')
    const table = await within(import_).findByRole('table', {
      name: 'Files of the legacy import and their classification',
    })
    expect(within(table).getByText('Recorded and present')).toBeInTheDocument()
    expect(within(table).getByText('Recorded, effect missing')).toBeInTheDocument()
    expect(within(table).getByText('Waiting for a decision')).toBeInTheDocument()
    expect(import_.querySelector('script')).toBeNull()
    expect(import_.textContent).toContain('⟨U+202E⟩')
    expect(import_.textContent).not.toContain(BIDI)
  })

  it('records a decision with a note and shows the updated report', async () => {
    const w = world()
    let current = report()
    w.on('GET', REPORT, () => ({ status: 200, body: current }))
    w.on('POST', /items\/2\/decision$/, (request) => {
      const body = request.body as { state: string; note: string }
      current = report({
        unresolved: 0,
        state: 'resolved',
        items: report().items.map((item) =>
          item.itemId === '2'
            ? {
                ...item,
                decision: {
                  state: body.state,
                  note: body.note,
                  decidedAt: new Date().toISOString(),
                },
              }
            : item,
        ),
      })
      return { status: 200, body: current }
    })
    mountOps(REPORT_PAGE, w)
    const user = userEvent.setup()
    const import_ = await section('Legacy import')
    await within(import_).findByRole('table', {
      name: 'Files of the legacy import and their classification',
    })
    // Only the review item can be decided.
    expect(import_.querySelectorAll('[data-decide]')).toHaveLength(1)
    await user.click(import_.querySelector('[data-decide="2"]') as HTMLElement)
    const dialog = await screen.findByRole('alertdialog')
    // Without a choice and a note nothing is sent.
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    expect(await within(dialog).findByText('Choose a decision first.')).toBeInTheDocument()
    expect(w.callsTo('POST', /decision/)).toHaveLength(0)
    await user.selectOptions(within(dialog).getByLabelText('Decision'), 'unrecorded_missing')
    await user.type(within(dialog).getByLabelText('Note'), 'Never applied on this target')
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    await waitFor(() => expect(w.callsTo('POST', /decision/)).toHaveLength(1))
    expect(w.callsTo('POST', /decision/)[0]?.body).toEqual({
      state: 'unrecorded_missing',
      note: 'Never applied on this target',
    })
    // The resolved report offers the baseline plan.
    expect(
      await within(import_).findByRole('button', { name: 'Create baseline plan' }),
    ).toBeInTheDocument()
  })

  it('creates the baseline plan from a resolved report and opens the plan', async () => {
    const w = world()
    w.on('GET', REPORT, report({ state: 'resolved', unresolved: 0 }))
    w.on('POST', /baseline-plans$/, { id: `pln_${ulid(4)}` }, 201)
    const { router } = mountOps(REPORT_PAGE, w)
    const user = userEvent.setup()
    const import_ = await section('Legacy import')
    await user.click(await within(import_).findByRole('button', { name: 'Create baseline plan' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/changes/plans/pln_${ulid(4)}`),
    )
    expect(w.callsTo('POST', /baseline-plans$/)[0]?.body).toEqual({
      importReportId: `imr_${ulid(1)}`,
    })
  })

  it('shows a failed report read as failed', async () => {
    const w = world()
    w.fail('GET', REPORT, 500, 'INTERNAL_ERROR')
    mountOps(REPORT_PAGE, w)
    const import_ = await section('Legacy import')
    expect(await within(import_).findByText(/Could not read import report/)).toBeInTheDocument()
  })
})
