import { describe, expect, it } from 'vitest'

import { buildTimelineModel } from '../../src/timeline/model.ts'
import {
  MIGRATION_MARKER_STATES,
  type MigrationTimelineData,
  markerStateFromStream,
  type TimelineBundle,
  type TimelineCell,
} from '../../src/timeline/types.ts'

const ENVIRONMENTS = [
  { id: 'development', name: 'Development', tier: 'nonprod' },
  { id: 'staging', name: 'Staging', tier: 'nonprod', evidenceFrom: 'development' },
  { id: 'production', name: 'Production', tier: 'prod', evidenceFrom: 'staging' },
] as const

function cell(
  environmentId: string,
  state: TimelineCell['state'],
  extra: Partial<TimelineCell> = {},
) {
  return { environmentId, state, ...extra }
}

function bundle(
  id: string,
  slug: string,
  dependsOn: string[],
  cells: TimelineCell[],
): TimelineBundle {
  return { id, slug, dependsOn, cells }
}

function data(bundles: TimelineBundle[], extra: Partial<MigrationTimelineData> = {}) {
  return { environments: ENVIRONMENTS, bundles, ...extra }
}

describe('markerStateFromStream', () => {
  it('keeps the states the timeline shows', () => {
    for (const state of ['not_applied', 'applied', 'verified', 'failed', 'reverted', 'pending']) {
      expect(markerStateFromStream(state)).toBe(state)
    }
  })

  it('shows a divergent ledger as drifted', () => {
    expect(markerStateFromStream('divergent')).toBe('drifted')
  })

  it('shows a state it does not know as unknown, never as a guess', () => {
    expect(markerStateFromStream('quarantined')).toBe('unknown')
    expect(markerStateFromStream('')).toBe('unknown')
    expect(MIGRATION_MARKER_STATES).toContain(markerStateFromStream('Verified'))
    expect(markerStateFromStream('Verified')).toBe('unknown')
  })
})

describe('buildTimelineModel', () => {
  it('keeps the environments in the order given (the evidence order), not sorted', () => {
    const model = buildTimelineModel(
      data([bundle('A', 'a', [], [])], {
        environments: [ENVIRONMENTS[2], ENVIRONMENTS[0], ENVIRONMENTS[1]],
      }),
    )

    expect(model.environments.map((environment) => environment.id)).toEqual([
      'production',
      'development',
      'staging',
    ])
    expect(model.rows[0]?.cells.map((entry) => entry.environmentId)).toEqual([
      'production',
      'development',
      'staging',
    ])
  })

  it('matches cells to environments whatever order the cells come in', () => {
    const model = buildTimelineModel(
      data([
        bundle(
          'A',
          'a',
          [],
          [
            cell('production', 'failed'),
            cell('development', 'verified'),
            cell('staging', 'applied'),
          ],
        ),
      ]),
    )

    expect(model.rows[0]?.cells.map((entry) => entry.state)).toEqual([
      'verified',
      'applied',
      'failed',
    ])
  })

  it('shows an environment without a cell as unknown, never as not applied', () => {
    const model = buildTimelineModel(
      data([bundle('A', 'a', [], [cell('development', 'verified')])]),
    )
    const cells = model.rows[0]?.cells ?? []

    expect(cells.map((entry) => entry.state)).toEqual(['verified', 'unknown', 'unknown'])
    expect(cells.map((entry) => entry.recorded)).toEqual([true, false, false])
  })

  it('shows two cells for one environment as unknown, never one of them', () => {
    const model = buildTimelineModel(
      data([bundle('A', 'a', [], [cell('staging', 'verified'), cell('staging', 'failed')])]),
    )
    const staging = model.rows[0]?.cells[1]

    expect(staging?.state).toBe('unknown')
    expect(staging?.conflicting).toBe(true)
  })

  it('carries the times and the evidence path of a cell, and nothing for null', () => {
    const model = buildTimelineModel(
      data([
        bundle(
          'A',
          'a',
          [],
          [
            cell('development', 'verified', {
              at: '2026-10-13T10:00:00Z',
              observedAt: '2026-10-13T14:00:00Z',
              evidencePath: '/changes/operations/op_1',
            }),
            cell('staging', 'applied', { at: null, observedAt: null, evidencePath: null }),
          ],
        ),
      ]),
    )
    const [first, second] = model.rows[0]?.cells ?? []

    expect(first).toMatchObject({
      at: '2026-10-13T10:00:00Z',
      observedAt: '2026-10-13T14:00:00Z',
      evidencePath: '/changes/operations/op_1',
    })
    expect(second).toMatchObject({ at: undefined, observedAt: undefined, evidencePath: undefined })
  })

  it('orders the rows by dependency, ties by id', () => {
    const model = buildTimelineModel(
      data([
        bundle('03', 'third', ['01'], []),
        bundle('02', 'second', [], []),
        bundle('01', 'first', [], []),
      ]),
    )

    expect(model.rows.map((row) => row.id)).toEqual(['01', '02', '03'])
  })

  it('classifies dependencies as bundles, baselines or unlisted ids, once each', () => {
    const model = buildTimelineModel(
      data(
        [bundle('01', 'first', [], []), bundle('02', 'second', ['01', 'base-1', 'gone', '01'], [])],
        { baselines: ['base-1'] },
      ),
    )

    expect(model.rows[1]?.dependencies).toEqual([
      { id: '01', name: 'first', kind: 'bundle' },
      { id: 'base-1', name: undefined, kind: 'baseline' },
      { id: 'gone', name: undefined, kind: 'unlisted' },
    ])
  })

  it('shows only the last rows above the limit and counts the hidden ones', () => {
    const bundles = ['01', '02', '03', '04', '05'].map((id) => bundle(id, `m${id}`, [], []))
    const model = buildTimelineModel(data(bundles), 2)

    expect(model.rows.map((row) => row.id)).toEqual(['04', '05'])
    expect(model.hiddenEarlier).toBe(3)
    expect(model.totalBundles).toBe(5)
  })

  it('knows a dependency outside the shown rows by name', () => {
    const bundles = [bundle('01', 'first', [], []), bundle('02', 'second', ['01'], [])]
    const model = buildTimelineModel(data(bundles), 1)

    expect(model.rows[0]?.dependencies).toEqual([{ id: '01', name: 'first', kind: 'bundle' }])
  })

  it('reports the bundles a server cut from the list', () => {
    const model = buildTimelineModel(data([bundle('01', 'a', [], [])], { totalBundleCount: 1_500 }))

    expect(model.totalBundles).toBe(1_500)
    expect(model.omittedByServer).toBe(1_499)
  })

  it('does not believe a total smaller than the list', () => {
    const model = buildTimelineModel(
      data([bundle('01', 'a', [], []), bundle('02', 'b', [], [])], { totalBundleCount: 1 }),
    )

    expect(model.totalBundles).toBe(2)
    expect(model.omittedByServer).toBe(0)
  })

  it('reports duplicate environments, cells of unlisted environments and ordering issues', () => {
    const model = buildTimelineModel({
      environments: [ENVIRONMENTS[0], { ...ENVIRONMENTS[0], name: 'Again' }, ENVIRONMENTS[1]],
      bundles: [
        bundle('A', 'a', ['B'], [cell('qa', 'verified')]),
        bundle('B', 'b', ['A'], []),
        bundle('A', 'a again', [], []),
      ],
    })

    expect(model.environments.map((environment) => environment.id)).toEqual([
      'development',
      'staging',
    ])
    expect(model.issues).toContainEqual({
      kind: 'duplicate_environment',
      id: 'development',
      dropped: 1,
    })
    expect(model.issues).toContainEqual({ kind: 'unlisted_environment', count: 1 })
    expect(model.issues).toContainEqual({ kind: 'duplicate_id', id: 'A', dropped: 1 })
    expect(model.issues).toContainEqual({ kind: 'cycle', ids: ['A', 'B'] })
  })
})
