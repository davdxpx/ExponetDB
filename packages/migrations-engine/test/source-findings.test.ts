import { describe, expect, it } from 'vitest'
import { sourceFindingList } from '../src/hotfix.ts'

/**
 * E18 (review of W10-3, H2): which applied migrations the finding names after a whole source
 * was compared. A source behind the target (an old clone) never opens or changes the finding;
 * the finding clears only when the source has every migration it names.
 */
const ref = (id: string) => ({ migrationId: id, name: `m-${id}` })

describe('applied_not_in_source after one whole source', () => {
  it('opens for an applied migration older than the newest bundle of the source', () => {
    expect(sourceFindingList({ newestId: 'B', older: [ref('A')], newer: [] }, [])).toEqual([
      ref('A'),
    ])
  })

  it('does not open for one newer than the newest bundle: the source is behind', () => {
    expect(sourceFindingList({ newestId: 'A', older: [], newer: [ref('B')] }, [])).toEqual([])
  })

  it('keeps a named migration a behind source also lacks, and does not clear', () => {
    expect(sourceFindingList({ newestId: 'A', older: [], newer: [ref('B')] }, ['B'])).toEqual([
      ref('B'),
    ])
  })

  it('clears only when the source has every named migration that is still applied', () => {
    // B is in the source again; C is no longer applied (reverted), so it is in neither list.
    expect(sourceFindingList({ newestId: 'D', older: [], newer: [] }, ['B', 'C'])).toEqual([])
  })

  it('lists the newest first', () => {
    expect(
      sourceFindingList({ newestId: 'Z', older: [ref('A'), ref('C')], newer: [] }, []),
    ).toEqual([ref('C'), ref('A')])
  })
})
