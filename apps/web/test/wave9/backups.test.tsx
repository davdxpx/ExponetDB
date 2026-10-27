import '@testing-library/jest-dom/vitest'
import { createHash, webcrypto } from 'node:crypto'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BACKUP,
  CLUSTER,
  catalog,
  DRILL,
  drill,
  mountWave9,
  NODE,
  OPERATION,
  PLAN,
  placedWorld,
  protection,
  REPO,
  repository,
  restore,
  TARGET,
  type Wave9World,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

beforeEach(() => {
  // jsdom has no object URLs; the download goes through one.
  URL.createObjectURL = vi.fn(() => 'blob:test')
  URL.revokeObjectURL = vi.fn()
})
afterEach(cleanup)

const PATH = '/t/shop/platform/staging/backups'
const ALL = [
  'backups.read',
  'backups.run',
  'restore.plan',
  'restore.execute',
  'registry.manage',
] as const

function list(key: string, items: unknown[], nextCursor: string | null = null) {
  return {
    clusterId: CLUSTER,
    [key]: items,
    nextCursor,
    source: 'control_store',
    observedAt: new Date().toISOString(),
  }
}

function world(): Wave9World {
  const w = placedWorld()
  w.permissions = [...ALL]
  w.catalog = catalog()
  w.repositories = {
    clusterId: CLUSTER,
    repositories: [repository()],
    source: 'control_store',
    observedAt: new Date().toISOString(),
  }
  w.policy = {
    clusterId: CLUSTER,
    policy: null,
    source: 'control_store',
    observedAt: new Date().toISOString(),
  }
  w.runs = list('runs', [])
  w.drills = list('drills', [
    drill(),
    drill({
      id: 'drl_01M4S9000000000000000000D2',
      mode: 'offline_runbook',
      outcome: 'attested',
      measuredRtoSeconds: 900,
    }),
  ])
  w.restores = list('restores', [restore()])
  w.clusterFindings = { items: [], nextCursor: null }
  w.nodes = {
    items: [
      {
        id: NODE,
        serverId: 'srv_01M4S9000000000000000000SV',
        state: 'online',
        agentVersion: null,
        capabilities: [],
        clockSkewMs: null,
        lastHeartbeatAt: null,
        protocolMajor: 1,
      },
    ],
    nextCursor: null,
  }
  return w
}

const protectionView = async () =>
  waitFor(() => {
    const found = document.querySelector('[data-protection-view]')
    if (found === null) throw new Error('not yet')
    return found as HTMLElement
  })

function action(name: string): HTMLElement {
  const found = document.querySelector(`[data-action="${name}"]`)
  if (found === null) throw new Error(`no action ${name}`)
  return found as HTMLElement
}

describe('backups of a target', () => {
  it('shows the protection with reasons, RPO basis and uncertainty, and RTO only from a passed drill', async () => {
    mountWave9(PATH, world())
    const view = await protectionView()
    const badge = view.querySelector('[data-protection]') as HTMLElement
    expect(badge).toHaveTextContent('Unproven')
    // Unproven is never drawn as good.
    expect(badge).toHaveAttribute('data-tone', 'neutral')
    expect(view).toHaveTextContent('No repository lock is proven.')
    expect(view).toHaveTextContent('No restore drill has run.')
    const rpo = view.querySelector('[data-fact="rpo"]') as HTMLElement
    expect(rpo).toHaveTextContent('2 min (± 1 min)')
    expect(rpo).toHaveTextContent('Measured from the latest archived WAL.')
    expect(rpo).toHaveTextContent('Objective 15 min.')
    expect(view.querySelector('[data-fact="rto"]')).toHaveTextContent(
      'Not measured: no drill passed',
    )
  })

  it('shows the measured RTO of a passed drill', async () => {
    const w = world()
    w.catalog = catalog({
      protection: protection({
        state: 'protected',
        reasons: [],
        rto: {
          measuredSeconds: 1500,
          drillId: DRILL,
          drillAt: new Date().toISOString(),
          objectiveSeconds: 3600,
        },
      }),
    })
    mountWave9(PATH, w)
    const view = await protectionView()
    expect(view.querySelector('[data-fact="rto"]')).toHaveTextContent('25 min')
    expect(view.querySelector('[data-protection]')).toHaveAttribute('data-tone', 'good')
  })

  it('never shows an unproven lock as protecting; a proven one is', async () => {
    const w = world()
    w.repositories = {
      clusterId: CLUSTER,
      repositories: [
        repository(),
        repository({
          id: 'bkr_01M4S9000000000000000000R2',
          lock: {
            mode: 's3_object_lock',
            capability: 'proven',
            retentionDays: 14,
            provenAt: new Date().toISOString(),
          },
        }),
      ],
      source: 'control_store',
      observedAt: new Date().toISOString(),
    }
    mountWave9(PATH, w)
    await waitFor(() => expect(document.querySelectorAll('[data-lock]')).toHaveLength(2))
    const unproven = document.querySelector('[data-lock="unproven"]') as HTMLElement
    expect(unproven).toHaveTextContent('Lock not proven')
    expect(unproven).toHaveAttribute('data-tone', 'neutral')
    const proven = document.querySelector('[data-lock="proven"]') as HTMLElement
    expect(proven).toHaveTextContent('Lock proven')
    expect(proven).toHaveAttribute('data-tone', 'good')
  })

  it('labels an offline drill as an attestation and never counts its time', async () => {
    mountWave9(PATH, world())
    const attested = await waitFor(() => {
      const found = document.querySelector('[data-mode="offline_runbook"]')
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    expect(attested).toHaveTextContent(
      'Attestation: recorded by a person, not observed by ExponetDB',
    )
    expect(attested).toHaveTextContent('Attested')
    expect(attested).toHaveTextContent('Not measured (attestation)')
    expect(attested).not.toHaveTextContent('15 min')
    expect(document.querySelector(`[data-drill="${DRILL}"]`)).toHaveTextContent('25 min')
  })

  it('shows each failed read (a route that is not there yet) as a named failure, never an empty list', async () => {
    const w = world()
    w.catalog = undefined
    w.drills = undefined
    mountWave9(PATH, w)
    expect(
      await screen.findByRole('heading', { name: 'Could not read backup catalog' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Could not read drills' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No drill is recorded for this cluster.')).toBeNull()
    expect(screen.getByText('The other actions need the catalog read above.')).toBeInTheDocument()
  })

  it('shows a cut backup list as partial, and an old catalog as stale', async () => {
    const w = world()
    w.catalog = catalog({ nextCursor: 'more-1' })
    mountWave9(PATH, w)
    expect(await screen.findByText('Showing part of backups')).toBeInTheDocument()
    cleanup()
    const old = world()
    old.catalog = catalog({ observedAt: new Date(Date.now() - 3_600_000).toISOString() })
    mountWave9(PATH, old)
    expect(
      (await screen.findAllByText('Showing an earlier read of backup catalog')).length,
    ).toBeGreaterThan(0)
  })

  it('says an empty list was read and found nothing', async () => {
    const w = world()
    w.drills = list('drills', [])
    mountWave9(PATH, w)
    expect(await screen.findByText('No drill is recorded for this cluster.')).toBeInTheDocument()
  })

  it('names the missing permission on each action it disables', async () => {
    const w = world()
    w.permissions = ['backups.read']
    mountWave9(PATH, w)
    await protectionView()
    const run = action('run')
    expect(within(run).getByRole('button', { name: 'Plan a backup run' })).toBeDisabled()
    expect(run).toHaveTextContent('You do not have the permission for this (backups.run).')
    expect(action('recovery')).toHaveTextContent('(restore.plan)')
    expect(action('offline')).toHaveTextContent('(restore.execute)')
  })

  it('disables an action with the reason after the server says FEATURE_NOT_ACTIVATED', async () => {
    const user = userEvent.setup()
    const w = world()
    w.refusals.set('POST /api/v1/clusters/', {
      status: 409,
      code: 'FEATURE_NOT_ACTIVATED',
      message: 'This installation has not activated the action for this tier.',
    })
    mountWave9(PATH, w)
    await protectionView()
    await user.click(within(action('run')).getByRole('button', { name: 'Plan a backup run' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    expect(await within(dialog).findByText(/FEATURE_NOT_ACTIVATED/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(
        within(action('run')).getByRole('button', { name: 'Plan a backup run' }),
      ).toBeDisabled(),
    )
    expect(action('run')).toHaveTextContent('FEATURE_NOT_ACTIVATED')
    expect(w.sent.find((s) => s.path.endsWith('/backup-runs'))?.body).toEqual({
      repositoryId: REPO,
      kind: 'full',
    })
  })

  it('plans a drill and opens its review page', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountWave9(PATH, w)
    await protectionView()
    await user.click(within(action('drill')).getByRole('button', { name: 'Plan a drill' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(w.sent.find((s) => s.path.endsWith('/drills'))?.body).toEqual({
      repositoryId: REPO,
      selection: { kind: 'latest' },
    })
  })

  it('plans a recovery only as a plan, into a new cluster on a chosen node, with a reason', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountWave9(PATH, w)
    await protectionView()
    await user.click(within(action('recovery')).getByRole('button', { name: 'Plan a recovery' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(
      'Only a person can execute it, on the plan page, with the target path typed.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Create recovery plan' }))
    expect(
      await within(dialog).findByText('Choose the node for the new cluster.'),
    ).toBeInTheDocument()
    await user.selectOptions(await within(dialog).findByLabelText('Node for the new cluster'), NODE)
    await user.type(within(dialog).getByLabelText('Reason (incident reference)'), 'INC-42')
    await user.click(within(dialog).getByRole('button', { name: 'Create recovery plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    const sent = w.sent.find((s) => s.path.endsWith('/restore-plans'))
    expect(sent?.path).toContain(encodeURIComponent(TARGET))
    expect(sent?.body).toEqual({
      purpose: 'recovery',
      repositoryId: REPO,
      source: { latest: true },
      destination: { kind: 'new_cluster', nodeId: NODE },
      reason: 'INC-42',
    })
  })

  it('verifies a backup as an operation that started, not as verified', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-backup="${BACKUP}"]`)
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    expect(row).toHaveTextContent('Not verified')
    await user.click(within(row).getByRole('button', { name: 'Verify' }))
    await user.click(await screen.findByRole('button', { name: 'Start verification' }))
    const notice = await waitFor(() => {
      const found = document.querySelector(`[data-started="${OPERATION}"]`)
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    expect(notice).toHaveTextContent('The backup is not verified until the run passed.')
    expect(within(notice).getByRole('link')).toHaveAttribute(
      'href',
      `/changes/operations/${OPERATION}`,
    )
    expect(w.sent.some((s) => s.path.endsWith(`/backups/${BACKUP}/verify`))).toBe(true)
  })

  it('plans the discard of a scratch restore', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountWave9(PATH, w)
    const row = await waitFor(() => {
      const found = document.querySelector('[data-restore]')
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    await user.click(within(row).getByRole('button', { name: 'Discard' }))
    await user.click(await screen.findByRole('button', { name: 'Create discard plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('downloads the runbook only after its digest matched, and shows the digest', async () => {
    if (globalThis.crypto.subtle === undefined) {
      Object.defineProperty(globalThis.crypto, 'subtle', {
        value: webcrypto.subtle,
        configurable: true,
      })
    }
    const user = userEvent.setup()
    const w = world()
    const script = '#!/bin/sh\necho restore\n'
    const digest = `sha256:${createHash('sha256').update(script).digest('hex')}`
    w.runbook = {
      clusterId: CLUSTER,
      repositoryId: REPO,
      repositoryRevision: 1,
      filename: 'exponetdb-restore-main.sh',
      digest,
      script,
      placeholders: [{ name: 'REPO_KEY_FILE', meaning: 'Path of the repository key' }],
      generatedAt: new Date().toISOString(),
    }
    mountWave9(PATH, w)
    const button = await waitFor(() => within(action('runbook')).getByRole('button'))
    await user.click(button)
    const saved = await waitFor(() => {
      const found = document.querySelector('[data-runbook]')
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    expect(saved).toHaveTextContent(digest)
    expect(saved).toHaveTextContent('REPO_KEY_FILE')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    cleanup()

    const bad = world()
    bad.runbook = { ...(w.runbook as object), digest: `sha256:${'00'.repeat(32)}` }
    mountWave9(PATH, bad)
    await user.click(await waitFor(() => within(action('runbook')).getByRole('button')))
    expect(
      await screen.findByText(/The script does not match its digest, so it was not saved./),
    ).toBeInTheDocument()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('records an offline drill as an attestation', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    await protectionView()
    await user.click(
      within(action('offline')).getByRole('button', { name: 'Record an offline drill' }),
    )
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('This is an attestation')
    await user.type(within(dialog).getByLabelText('Runbook digest'), `sha256:${'ef'.repeat(32)}`)
    fireEvent.change(within(dialog).getByLabelText('Restored at (your local time)'), {
      target: { value: '2026-10-20T10:00' },
    })
    await user.type(within(dialog).getByLabelText('Duration in minutes'), '30')
    await user.type(
      within(dialog).getByLabelText('What was run, where, and what was checked'),
      'Lab host, probes passed',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Record attestation' }))
    expect(await within(dialog).findByText('Confirm the attestation.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Record attestation' }))
    expect(await screen.findByText(/Recorded as an attestation/)).toBeInTheDocument()
    const body = w.sent.find((s) => s.path.endsWith('/drills/offline'))?.body as Record<
      string,
      unknown
    >
    expect(body).toMatchObject({ repositoryId: REPO, durationSeconds: 1800, outcome: 'passed' })
  })

  it('says when no cluster is recorded for the target', async () => {
    const w = world()
    w.update(TARGET, { placement: null })
    mountWave9(PATH, w)
    expect(
      await screen.findByRole('heading', { name: 'No cluster is recorded for this target' }),
    ).toBeInTheDocument()
    expect(w.requests.some((r) => r.includes('/clusters/'))).toBe(false)
  })

  it('has no axe violations', async () => {
    mountWave9(PATH, world())
    await protectionView()
    await waitFor(() =>
      expect(document.querySelector('[data-mode="offline_runbook"]')).not.toBeNull(),
    )
    expect(await axeViolations(document.body)).toEqual([])
  })
})
