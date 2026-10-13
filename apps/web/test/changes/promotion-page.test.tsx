import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  ChangesWorld,
  M1,
  M2,
  mountChanges,
  PROJECT,
  PROJECT2,
  project,
  stream,
  TAG,
} from './support.tsx'

afterEach(cleanup)

const label = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`

function promotionWorld(): ChangesWorld {
  const world = new ChangesWorld()
  world.projects = [
    project(PROJECT, 'shop/platform'),
    project(PROJECT2, `shop/billing${BIDI}${TAG}<script>x</script>`),
  ]
  world.streams.set(PROJECT, stream())
  return world
}

async function openPromotion(world: ChangesWorld, path = `/changes/promotion?project=${PROJECT}`) {
  const mounted = mountChanges(path, world)
  await screen.findByRole('heading', { level: 1, name: 'Promotion' })
  return mounted
}

const timeline = () => document.querySelector(`[data-stream="${PROJECT}"]`) as HTMLElement | null

describe('the promotion view', () => {
  it('asks to pick a project, lists them as links and renders hostile paths as text', async () => {
    const world = promotionWorld()
    await openPromotion(world, '/changes/promotion')
    expect(await screen.findByText(/Pick a project/)).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Projects' })
    expect(await within(nav).findByRole('link', { name: /shop.*platform/ })).toHaveAttribute(
      'href',
      `/changes/promotion?project=${PROJECT}`,
    )
    expect(nav.textContent).toContain(label(0x202e))
    expect(nav.textContent).toContain(label(0xe0041))
    expect(document.querySelector('script')).toBeNull()
    expect(world.gets('/migrations')).toHaveLength(0)
  })

  it('ignores a project parameter that is not a project id and requests nothing for it', async () => {
    const world = promotionWorld()
    await openPromotion(world, `/changes/promotion?project=${encodeURIComponent('prj_../x')}`)
    expect(await screen.findByText(/Pick a project/)).toBeInTheDocument()
    expect(world.gets('/migrations')).toHaveLength(0)
  })

  it('shows a failed projects read as failed, not as none', async () => {
    const world = promotionWorld()
    world.failures.set('GET /api/v1/projects?', {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry is unavailable.',
    })
    await openPromotion(world, '/changes/promotion')
    expect(await screen.findByText('The registry is unavailable.')).toBeInTheDocument()
  })

  it('shows bundles in dependency order, environments in evidence order, and an absent cell as unknown', async () => {
    await openPromotion(promotionWorld())
    await waitFor(() => expect(timeline()?.querySelector('[data-marker-state]')).not.toBeNull())
    const root = timeline() as HTMLElement
    const environments = [...root.querySelectorAll('[data-environment-index]')].map(
      (e) => e.textContent ?? '',
    )
    expect(environments[0]).toContain('Staging')
    expect(environments[1]).toContain('Production')
    expect(root.querySelector('[data-tier="production"]')).not.toBeNull()
    const markers = [...root.querySelectorAll('[data-marker-row]')].map((m) => [
      m.getAttribute('data-marker-row'),
      m.getAttribute('data-marker-col'),
      m.querySelector('[data-marker-state]')?.getAttribute('data-marker-state') ??
        m.getAttribute('data-marker-state'),
    ])
    // Row 0 is the dependency (create_accounts), row 1 depends on it (add_notes).
    expect(markers).toContainEqual(['0', '0', 'verified'])
    expect(markers).toContainEqual(['0', '1', 'drifted'])
    expect(markers).toContainEqual(['1', '0', 'applied'])
    // The mirror holds nothing for add_notes on production: unknown, never "not applied".
    expect(markers).toContainEqual(['1', '1', 'unknown'])
    expect(markers.some((m) => m[2] === 'not_applied')).toBe(false)
    expect(root.textContent).toContain(M1.slice(0, 6))
    expect(root.textContent).not.toContain('undefined')
    void M2
  })

  it('shows the loading state, then a failed stream read as failed and not as empty', async () => {
    const loading = promotionWorld()
    loading.held.add(`/projects/${PROJECT}/migrations`)
    await openPromotion(loading)
    await waitFor(() => expect(timeline()?.querySelector('[data-state="loading"]')).not.toBeNull())
    cleanup()
    const world = promotionWorld()
    world.failures.set(`/projects/${PROJECT}/migrations`, {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'You may not read the migrations of this project.',
    })
    await openPromotion(world)
    expect(
      await screen.findByText('You may not read the migrations of this project.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('No migration bundles')).toBeNull()
  })

  it('says there are no bundles only after a successful read', async () => {
    const world = promotionWorld()
    world.streams.set(PROJECT, stream({ bundles: [], bundleCount: 0, heads: [] }))
    await openPromotion(world)
    expect(await screen.findByText('No migration bundles')).toBeInTheDocument()
  })

  it('names what is missing when the stream is truncated or its graph is invalid', async () => {
    const world = promotionWorld()
    world.streams.set(
      PROJECT,
      stream({
        truncated: true,
        bundleCount: 1500,
        graph: {
          valid: false,
          errors: [{ code: 'MIGRATION_DEPENDENCY_CYCLE', migrationIds: [M1] }],
        },
      }),
    )
    await openPromotion(world)
    expect(await screen.findByText(/Only the newest 2 of 1500 migrations/)).toBeInTheDocument()
    expect(screen.getByText(/MIGRATION_DEPENDENCY_CYCLE/)).toBeInTheDocument()
  })

  it('shows a stale stream with its age when a refresh fails', async () => {
    const world = promotionWorld()
    const { queryClient } = await openPromotion(world)
    await waitFor(() => expect(timeline()?.querySelector('[data-marker-state]')).not.toBeNull())
    world.failures.set(`/projects/${PROJECT}/migrations`, {
      status: 500,
      code: 'INTERNAL',
      message: 'The mirror is unavailable.',
    })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['projects', 'stream', PROJECT] })
    })
    await waitFor(() => expect(timeline()?.querySelector('[data-state="stale"]')).not.toBeNull())
    expect(timeline()?.querySelector('[data-marker-state]')).not.toBeNull()
  })

  it('has no accessibility violations', async () => {
    await openPromotion(promotionWorld())
    await waitFor(() => expect(timeline()?.querySelector('[data-marker-state]')).not.toBeNull())
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('all changes', () => {
  it('links the plans, the operations (with state filters), approvals and the promotion view', async () => {
    mountChanges('/changes', new ChangesWorld())
    await screen.findByRole('heading', { level: 1, name: 'All changes' })
    const links = [...document.querySelectorAll('main a, #content a')].map((a) =>
      a.getAttribute('href'),
    )
    for (const href of [
      '/changes/plans',
      '/approvals',
      '/changes/operations',
      '/changes/operations?state=running',
      '/changes/operations?state=needs_attention',
      '/changes/operations?state=failed',
      '/changes/promotion',
    ]) {
      expect(links, href).toContain(href)
    }
    expect(await axeViolations(document.body)).toEqual([])
  })
})
