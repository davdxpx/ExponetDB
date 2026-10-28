import { describe, expect, it } from 'vitest'
import type { CoverageRecord } from '../src/records.ts'
import {
  PITR_MARGIN_MS,
  type SelectableBackup,
  type Selection,
  selectSource,
} from '../src/selection.ts'

/**
 * Which backup and WAL range a restore uses (restore.md §2; test campaign TC-028): the M-6 matrix
 * names "oldest, latest, PITR random", and the server tests only ever used `latest`. Pure: a fixture
 * catalog of one repository with three verified bases, and its WAL coverage.
 */
const REPO = 'bkr_01M60000000000000000000001'
const NOW = Date.parse('2026-10-26T12:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

type Verification = 'pending' | 'passed' | 'failed'

function base(
  n: number,
  finishedAgoMs: number,
  walStart: string,
  over: {
    verification?: Verification
    state?: string
    divergence?: string
    kind?: string
  } = {},
): SelectableBackup {
  return {
    view: {
      id: `bkp_01M6000000000000000000000${n}`,
      repositoryId: REPO,
      engineLabel: `20261023-0${n}F`,
      kind: over.kind ?? 'full',
      state: over.state ?? 'succeeded',
      startedAt: new Date(NOW - finishedAgoMs - 10 * 60_000).toISOString(),
      finishedAt: new Date(NOW - finishedAgoMs).toISOString(),
      lsnStart: null,
      lsnStop: null,
      timeline: 1,
      postgresMajor: 17,
      engineVersion: '2.59.3',
      verification: {
        state: over.verification ?? 'passed',
        verifiedAt: over.verification === 'pending' ? null : new Date(NOW - 60_000).toISOString(),
      },
      divergence: over.divergence ?? 'none',
    } as unknown as SelectableBackup['view'],
    walStart,
    systemIdentifier: '7701448509665702082',
  }
}

const OLDEST = base(1, 3 * DAY, '000000010000000100000010')
const MIDDLE = base(2, 2 * DAY, '000000010000000100000020')
const NEWEST = base(3, 1 * DAY, '000000010000000100000030')
const THREE = [NEWEST, OLDEST, MIDDLE] // unsorted on purpose

const coverage = (over: Partial<CoverageRecord> = {}): CoverageRecord => ({
  repositoryId: REPO,
  archiveId: '17-1',
  timeline: 1,
  minSegment: '000000010000000100000001',
  maxSegment: '000000010000000100000040',
  maxArchivedAt: new Date(NOW - 10 * 60_000),
  gapEnds: [],
  observedAt: new Date(NOW),
  ...over,
})

const idOf = (s: Selection) => (s.ok ? s.source.backupId : s.reason)

describe('latest and older', () => {
  it('latest is the newest verified base; an unverified newer one is not preferred', () => {
    expect(idOf(selectSource(THREE, [coverage()], { kind: 'latest' }))).toBe(NEWEST.view.id)
    const newerButPending = base(4, 1 * HOUR, '000000010000000100000038', {
      verification: 'pending',
    })
    expect(idOf(selectSource([...THREE, newerButPending], [coverage()], { kind: 'latest' }))).toBe(
      NEWEST.view.id,
    )
  })

  it('latest falls back to the newest base when none is verified, and refuses an empty catalog', () => {
    const pending = [base(1, 2 * DAY, '000000010000000100000010', { verification: 'pending' })]
    expect(idOf(selectSource(pending, [coverage()], { kind: 'latest' }))).toBe(pending[0]?.view.id)
    expect(idOf(selectSource([], [coverage()], { kind: 'latest' }))).toBe('no_backup_selectable')
  })

  it('older is the second verified base and needs a second one', () => {
    expect(idOf(selectSource(THREE, [coverage()], { kind: 'older' }))).toBe(MIDDLE.view.id)
    expect(idOf(selectSource([NEWEST], [coverage()], { kind: 'older' }))).toBe(
      'no_backup_selectable',
    )
  })

  it('never offers a failed, running, logical or engine-missing base', () => {
    const unusable = [
      base(5, 1 * HOUR, '000000010000000100000040', { state: 'failed' }),
      base(6, 1 * HOUR, '000000010000000100000040', { state: 'running' }),
      base(7, 1 * HOUR, '000000010000000100000040', { kind: 'logical' }),
      base(8, 1 * HOUR, '000000010000000100000040', { divergence: 'missing_in_engine' }),
    ]
    expect(idOf(selectSource(unusable, [coverage()], { kind: 'latest' }))).toBe(
      'no_backup_selectable',
    )
  })
})

describe('a base by name', () => {
  it('resolves a listed base and refuses an unknown or unusable one', () => {
    const got = selectSource(THREE, [coverage()], { kind: 'backup', backupId: OLDEST.view.id })
    expect(got.ok && got.source).toMatchObject({
      backupId: OLDEST.view.id,
      label: '20261023-01F',
      walFrom: expect.any(String),
      walContinuous: true,
    })
    expect(
      idOf(selectSource(THREE, [coverage()], { kind: 'backup', backupId: 'bkp_unknown' })),
    ).toBe('backup_not_found')
    const missing = base(9, 1 * HOUR, '000000010000000100000040', {
      divergence: 'missing_in_engine',
    })
    expect(
      idOf(selectSource([missing], [coverage()], { kind: 'backup', backupId: missing.view.id })),
    ).toBe('backup_not_found')
  })
})

describe('a point in time', () => {
  it('uses the newest verified base at or before the point and keeps the point', () => {
    const at = NOW - 36 * HOUR // between MIDDLE (2 days ago) and NEWEST (1 day ago)
    const got = selectSource(THREE, [coverage()], { kind: 'pitr', atMs: at })
    expect(got.ok && got.source).toMatchObject({
      backupId: MIDDLE.view.id,
      pointInTime: new Date(at).toISOString(),
      walContinuous: true,
    })
  })

  it('refuses a point before the oldest base and a point the archive does not reach', () => {
    expect(idOf(selectSource(THREE, [coverage()], { kind: 'pitr', atMs: NOW - 4 * DAY }))).toBe(
      'point_in_time_outside_window',
    )
    // The archive ends ten minutes ago: a point after that is not shown as restorable.
    expect(idOf(selectSource(THREE, [coverage()], { kind: 'pitr', atMs: NOW - 1 * 60_000 }))).toBe(
      'point_in_time_outside_window',
    )
    // And with no recorded time for the newest segment, nothing is claimed.
    expect(
      idOf(
        selectSource(THREE, [coverage({ maxArchivedAt: null })], {
          kind: 'pitr',
          atMs: NOW - 36 * HOUR,
        }),
      ),
    ).toBe('point_in_time_outside_window')
  })
})

describe('a random point in time', () => {
  it('draws inside the oldest continuous window, a margin before the end of the archive', () => {
    const from = NOW - 3 * DAY
    const to = NOW - 10 * 60_000 - PITR_MARGIN_MS
    const low = selectSource(THREE, [coverage()], { kind: 'pitr_random' }, () => 0)
    expect(low.ok && low.source).toMatchObject({
      backupId: OLDEST.view.id,
      pointInTime: new Date(from).toISOString(),
    })
    const high = selectSource(THREE, [coverage()], { kind: 'pitr_random' }, () => 0.999999)
    expect(high.ok).toBe(true)
    if (high.ok) {
      expect(Date.parse(high.source.pointInTime ?? '')).toBeLessThanOrEqual(to)
      expect(Date.parse(high.source.pointInTime ?? '')).toBeGreaterThan(to - 60_000)
      // The newest verified base at or before the drawn instant.
      expect(high.source.backupId).toBe(NEWEST.view.id)
    }
  })

  it('starts after a gap in the archive: the oldest base from which it is continuous', () => {
    // A gap ends after the oldest base started, so the archive is not continuous from it.
    const gapped = coverage({ gapEnds: ['000000010000000100000018'] })
    const got = selectSource(THREE, [gapped], { kind: 'pitr_random' }, () => 0)
    expect(got.ok && got.source.backupId).toBe(MIDDLE.view.id)
  })

  it('refuses without coverage or with a window shorter than the margin', () => {
    expect(idOf(selectSource(THREE, [], { kind: 'pitr_random' }))).toBe('no_backup_selectable')
    const justEnded = coverage({ maxArchivedAt: new Date(NOW - 3 * DAY + 60_000) })
    expect(idOf(selectSource(THREE, [justEnded], { kind: 'pitr_random' }))).toBe(
      'point_in_time_outside_window',
    )
  })
})
