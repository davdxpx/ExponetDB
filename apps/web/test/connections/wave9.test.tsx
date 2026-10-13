import '@testing-library/jest-dom/vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { TARGET_NAV } from '../../src/shell/navigation.ts'
import { DiagnosticsWorld, mountDiagnostics, project } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

function world(): DiagnosticsWorld {
  const w = new DiagnosticsWorld()
  project(w)
  w.sample('shop/platform/staging')
  return w
}

const PAGES = [
  ['performance', 'Performance', 'Statement statistics by digest'],
  ['advisors', 'Advisors', 'Findings from live advisors'],
  ['backups', 'Backups', 'The backups that protect this target'],
] as const

describe('the Wave 9 pages of a target', () => {
  it.each(PAGES)(
    '/%s is a named "not available yet" state with what will come',
    async (section, label, coming) => {
      const w = world()
      mountDiagnostics(`/t/shop/platform/staging/${section}`, w)
      expect(await screen.findByRole('heading', { level: 1, name: label })).toBeInTheDocument()
      expect(
        await screen.findByRole('heading', { level: 2, name: `${label} is not available yet` }),
      ).toBeInTheDocument()
      expect(screen.getByText(/arrives with Wave 9/)).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name: 'What will come' })).toBeInTheDocument()
      expect(screen.getByText(new RegExp(coming))).toBeInTheDocument()
      // The navigation is the target's: the page is one of its sections, marked current.
      const nav = screen.getByRole('navigation', { name: 'Target sections' })
      expect(within(nav).getAllByRole('link')).toHaveLength(TARGET_NAV.length)
      expect(within(nav).getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page')
    },
  )

  it.each(PAGES)('/%s renders no data and asks the server for none', async (section, _label) => {
    const w = world()
    mountDiagnostics(`/t/shop/platform/staging/${section}`, w)
    await screen.findByRole('heading', { level: 2, name: 'What will come' })
    expect(document.querySelector('table')).toBeNull()
    expect(document.querySelector('canvas, svg[role="img"]')).toBeNull()
    expect(
      w.apiRequests.filter((r) => /query-stats|table-stats|advisor|backups|restore/.test(r)),
    ).toEqual([])
    // Only the target itself is read, for the page chrome.
    expect(
      w.apiRequests.every(
        (r) => /^\/api\/v1\/targets\/[^/]+(\?.*)?$/.test(r) || r.includes('/targets?'),
      ),
    ).toBe(true)
  })

  it('shows the production cue on a production target', async () => {
    const w = world()
    mountDiagnostics('/t/shop/platform/production/backups', w)
    await screen.findByRole('heading', { level: 2, name: 'Backups is not available yet' })
    const cue = document.querySelector('[data-slot="page-header-production-cue"]') as HTMLElement
    expect(within(cue).getByText('Production')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    mountDiagnostics('/t/shop/platform/staging/performance', world())
    await screen.findByRole('heading', { level: 2, name: 'What will come' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the global backups page', () => {
  it('exists at /backups as a named state with what will come, and renders no data', async () => {
    const w = world()
    const { router } = mountDiagnostics('/backups', w)
    expect(await screen.findByRole('heading', { level: 1, name: 'Backups' })).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Backups is not available yet' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/arrives with Wave 9/)).toBeInTheDocument()
    expect(screen.getByText(/Per cluster: the protection state/)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/backups')
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull()
    expect(document.querySelector('table')).toBeNull()
    expect(w.apiRequests).toEqual([])
  })

  it('has no axe violations', async () => {
    mountDiagnostics('/backups', world())
    await screen.findByRole('heading', { level: 2, name: 'What will come' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
