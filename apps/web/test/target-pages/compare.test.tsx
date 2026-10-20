import '@testing-library/jest-dom/vitest'
import { act, cleanup, configure, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { BIDI, HOSTILE, mountOps, OpsWorld, PROD_TARGET, project, TARGET } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

afterEach(cleanup)

const DIFFS = /\/api\/v1\/schema-diffs$/
const page = (query = '', path = TARGET) => `/t/${path}/compare${query}`

function ref(schema: string, name: string, kind: string, parent: string | null = null) {
  return { key: [kind, schema, parent ?? '', name], kind, name, parent, schema, signature: null }
}

function diff(over: Record<string, unknown> = {}) {
  return {
    comparable: true,
    left: { fingerprint: `fp1:17:${'a'.repeat(64)}` },
    right: { fingerprint: `fp1:17:${'b'.repeat(64)}` },
    groups: [
      {
        objectClass: 'table',
        added: [ref('public', 'invoices', 'table')],
        removed: [ref('public', HOSTILE, 'table')],
        changed: [{ ref: ref('public', 'orders', 'table'), attributes: ['columns'] }],
      },
      {
        objectClass: 'policy',
        added: [],
        removed: [],
        changed: [
          { ref: ref('public', 'tenant_isolation', 'policy', 'orders'), attributes: ['qual'] },
        ],
      },
    ],
    totals: { added: 1, removed: 1, changed: 2, matched: 40, securityRelevant: 1 },
    securityRelevant: [ref('public', 'tenant_isolation', 'policy', 'orders')],
    truncated: false,
    ...over,
  }
}

function world(path = TARGET): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(path)
  w.on('POST', DIFFS, diff())
  return w
}

async function differences(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name: 'Differences' })
  const root = heading.closest('[data-slot="page-section"]')
  if (!(root instanceof HTMLElement)) throw new Error('no differences section')
  return root
}

async function state(name: string): Promise<HTMLElement> {
  const section = await differences()
  return waitFor(() => {
    const element = section.querySelector(`[data-compare-state="${name}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no state ${name} yet`)
    return element
  })
}

describe('compare environments: which environment', () => {
  it('asks to pick an environment of the project, links each, and compares nothing yet', async () => {
    const w = world()
    mountOps(page(), w)
    expect(await state('pick')).toHaveTextContent('Pick an environment above')
    const picker = await waitFor(() => {
      const element = document.querySelector('[data-compare-picker]')
      if (!(element instanceof HTMLElement)) throw new Error('no picker yet')
      return element
    })
    expect(within(picker).getByRole('link', { name: /production/ })).toHaveAttribute(
      'href',
      `/t/${TARGET}/compare?to=production`,
    )
    // The page's own environment is not offered.
    expect(within(picker).queryByRole('link', { name: /^staging/ })).toBeNull()
    expect(w.callsTo('POST', DIFFS)).toHaveLength(0)
  })

  it('ignores a hostile or malformed environment in the address and requests nothing', async () => {
    for (const bad of ['../x', '<script>x</script>', 'PRODUCTION', `prod${BIDI}`]) {
      const w = world()
      mountOps(page(`?to=${encodeURIComponent(bad)}`), w)
      expect(await state('pick'), bad).toBeInTheDocument()
      expect(w.callsTo('POST', DIFFS)).toHaveLength(0)
      expect(document.querySelector('script')).toBeNull()
      cleanup()
    }
  })

  it('names an environment that is not one of the project’s and compares nothing', async () => {
    const w = world()
    mountOps(page('?to=preview'), w)
    expect(await state('unknown-environment')).toHaveTextContent(
      'preview is not an environment of this project that you may see. Nothing is compared.',
    )
    expect(w.callsTo('POST', DIFFS)).toHaveLength(0)
  })

  it('says a target compared with itself shows nothing, and asks for nothing', async () => {
    const w = world()
    mountOps(page('?to=staging'), w)
    expect(await state('same')).toHaveTextContent('This is staging itself.')
    expect(w.callsTo('POST', DIFFS)).toHaveLength(0)
  })

  it('cannot check the environment when the environments read failed, and compares nothing', async () => {
    const w = world()
    w.failures.set('/api/v1/targets?', { status: 500, code: 'INTERNAL', message: 'Boom.' })
    mountOps(page('?to=production'), w)
    expect(await state('unchecked')).toHaveTextContent(
      'Whether production is an environment of this project cannot be checked',
    )
    expect(w.callsTo('POST', DIFFS)).toHaveLength(0)
  })
})

describe('compare environments: the comparison', () => {
  it('compares this target (left) with the other (right) and shows each difference as text', async () => {
    const w = world()
    mountOps(page('?to=production'), w)
    const shown = await state('diff')
    await within(shown).findByText('invoices')
    expect(w.callsTo('POST', DIFFS)[0]?.body).toEqual({
      left: { target: TARGET },
      right: { target: PROD_TARGET },
    })
    expect(shown.querySelectorAll('li[data-change="added"]')).toHaveLength(1)
    expect(shown.querySelectorAll('li[data-change="removed"]')).toHaveLength(1)
    expect(shown.querySelectorAll('li[data-change="changed"]')).toHaveLength(2)
    expect(shown.querySelector('[data-compare-totals]')).toHaveTextContent(
      '1 added, 1 removed, 2 changed, 40 the same; 1 security-relevant.',
    )
    // A hostile name stays text: no element, direction characters by code point.
    expect(shown.querySelector('script')).toBeNull()
    expect(shown.textContent).toContain('⟨U+202E⟩')
    expect(shown.textContent).not.toContain(BIDI)
    // No merge or apply control: the page is read only.
    expect(within(shown).queryByRole('button', { name: /apply|merge|plan/i })).toBeNull()
  })

  it('names SCHEMA_FINGERPRINT_MISMATCH and never says "No differences"', async () => {
    const w = world()
    w.fail('POST', DIFFS, 409, 'SCHEMA_FINGERPRINT_MISMATCH')
    mountOps(page('?to=production'), w)
    const named = await state('SCHEMA_FINGERPRINT_MISMATCH')
    expect(named).toHaveTextContent('The two schemas cannot be compared')
    expect(named).toHaveTextContent(
      'SCHEMA_FINGERPRINT_MISMATCH happened. (SCHEMA_FINGERPRINT_MISMATCH)',
    )
    expect(within(named).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByText('No differences')).toBeNull()
  })

  it('names a stale schema sample (SAMPLE_STALE) and never says "No differences"', async () => {
    const w = world()
    w.fail('POST', DIFFS, 503, 'SAMPLE_STALE')
    mountOps(page('?to=production'), w)
    expect(await state('SAMPLE_STALE')).toHaveTextContent('A schema sample is too old to compare')
    expect(screen.queryByText('No differences')).toBeNull()
  })

  it('names schemas that are not comparable, never as no differences', async () => {
    const w = world()
    w.on(
      'POST',
      DIFFS,
      diff({
        comparable: false,
        groups: [],
        totals: { added: 0, removed: 0, changed: 0, matched: 0, securityRelevant: 0 },
      }),
    )
    mountOps(page('?to=production'), w)
    expect(await state('not_comparable')).toHaveTextContent('These schemas cannot be compared')
    expect(screen.queryByText('No differences')).toBeNull()
  })

  it('shows a failed comparison as failed, not as no differences', async () => {
    const w = world()
    w.fail('POST', DIFFS, 500, 'INTERNAL')
    mountOps(page('?to=production'), w)
    expect(await screen.findByText(/Could not read schema differences/)).toBeInTheDocument()
    expect(screen.queryByText('No differences')).toBeNull()
  })

  it('names the missing permission instead of a comparison', async () => {
    const w = world()
    w.fail('POST', DIFFS, 403, 'PERMISSION_DENIED')
    mountOps(page('?to=production'), w)
    expect(await screen.findByText('schema.read')).toBeInTheDocument()
    expect(screen.queryByText('No differences')).toBeNull()
  })

  it('says a truncated diff is partial and names what is missing', async () => {
    const w = world()
    w.on(
      'POST',
      DIFFS,
      diff({
        truncated: true,
        totals: { added: 3, removed: 3, changed: 3, matched: 1, securityRelevant: 1 },
      }),
    )
    mountOps(page('?to=production'), w)
    expect(await screen.findByText(/The server lists 4 of 9 differences/)).toBeInTheDocument()
    expect(document.querySelector('[data-state="partial"]')).not.toBeNull()
  })

  it('says "No differences" only after a successful read of an empty diff', async () => {
    const w = world()
    w.on(
      'POST',
      DIFFS,
      diff({
        groups: [],
        securityRelevant: [],
        totals: { added: 0, removed: 0, changed: 0, matched: 41, securityRelevant: 0 },
      }),
    )
    mountOps(page('?to=production'), w)
    expect(await screen.findByText('No differences')).toBeInTheDocument()
    expect(screen.queryByText(/Could not read/)).toBeNull()
  })

  it('keeps an earlier comparison as stale with its age and a refresh when a refresh fails', async () => {
    const w = world()
    const { queryClient } = mountOps(page('?to=production'), w)
    const shown = await state('diff')
    await within(shown).findByText('invoices')
    w.fail('POST', DIFFS, 500, 'INTERNAL')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['schema-diff'] })
    })
    await waitFor(() => expect(document.querySelector('[data-state="stale"]')).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(within(shown).getByText('invoices')).toBeInTheDocument()
  })

  it('carries the production cue on a production target', async () => {
    const w = world(PROD_TARGET)
    mountOps(page('?to=staging', PROD_TARGET), w)
    expect(await screen.findByRole('heading', { level: 1, name: /Compare environments/ }))
    await waitFor(() => expect(document.querySelector('[data-production-frame]')).not.toBeNull())
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
  })

  it('has no accessibility violations', async () => {
    mountOps(page('?to=production'), world())
    const shown = await state('diff')
    await within(shown).findByText('invoices')
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })
})
