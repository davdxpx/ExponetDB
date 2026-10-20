import type { MigrationStream } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import {
  candidatesFor,
  defaultDestination,
  evidenceOf,
  evidenceWarns,
  FILE_TEXT_MAX_CHARS,
  filesOfRevision,
  isBundleFile,
  isMigrationId,
  isRevision,
  pickRevision,
  previousRevision,
  revisionsNewestFirst,
  shownText,
} from '../../src/features/migrations/bundle-model.ts'
import { stream, ulid } from './support.tsx'

const S = stream() as unknown as MigrationStream

function revision(n: number, files: readonly string[]) {
  return {
    revision: n,
    bundleDigest: `sha256:c1:${String(n).repeat(64)}`,
    verifyDigest: null,
    rollbackDigest: null,
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    files: Object.fromEntries(
      files.map((f) => [f, { bytes: 1, digest: `sha256:${'b'.repeat(64)}` }]),
    ),
    source: null,
    ingestedAt: '2026-10-13T08:00:00.000Z',
  }
}

describe('ids and files the panel may request', () => {
  it('accepts a migration ULID only', () => {
    expect(isMigrationId(ulid(1))).toBe(true)
    for (const bad of ['', '../x', `${ulid(1)}x`, ulid(1).toLowerCase(), 'baseline:legacy', 7]) {
      expect(isMigrationId(bad), String(bad)).toBe(false)
    }
  })

  it('accepts positive safe integer revisions and the three readable files only', () => {
    expect(isRevision(1)).toBe(true)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '1']) {
      expect(isRevision(bad), String(bad)).toBe(false)
    }
    expect(isBundleFile('down.sql')).toBe(true)
    expect(isBundleFile('migration.yaml')).toBe(false)
    expect(isBundleFile('../up.sql')).toBe(false)
  })

  it('orders revisions newest first and picks the wanted one, else the newest', () => {
    const bundle = {
      revisions: [revision(1, ['up.sql']), revision(3, ['up.sql']), revision(2, [])],
    }
    expect(revisionsNewestFirst(bundle).map((r) => r.revision)).toEqual([3, 2, 1])
    expect(pickRevision(bundle, 2)?.revision).toBe(2)
    expect(pickRevision(bundle, 9)?.revision).toBe(3)
    expect(pickRevision(bundle, undefined)?.revision).toBe(3)
    expect(pickRevision({ revisions: [] }, 1)).toBeUndefined()
    expect(previousRevision(bundle, 3)?.revision).toBe(2)
    expect(previousRevision(bundle, 1)).toBeUndefined()
  })

  it('lists the files a revision stores in reading order, never the manifest', () => {
    expect(filesOfRevision(revision(1, ['down.sql', 'migration.yaml', 'up.sql']))).toEqual([
      'up.sql',
      'down.sql',
    ])
  })

  it('cuts a text longer than the page renders and says so', () => {
    expect(shownText('abc')).toEqual({ text: 'abc', truncated: false })
    const long = shownText('x'.repeat(FILE_TEXT_MAX_CHARS + 5))
    expect(long.truncated).toBe(true)
    expect(long.text).toHaveLength(FILE_TEXT_MAX_CHARS)
  })
})

describe('evidence before planning on production', () => {
  const pending = { migrationId: ulid(1), checksum: null }

  it('does not apply to a destination every known tier names nonprod', () => {
    expect(evidenceOf(S, { slug: 'staging', tier: 'nonprod' }, pending)).toEqual({
      kind: 'not_required',
    })
  })

  it('fails closed: a destination whose tier is not known is production', () => {
    expect(evidenceOf(undefined, { slug: 'x', tier: null }, pending)).toEqual({
      kind: 'not_known',
      from: null,
    })
    expect(evidenceOf(undefined, { slug: 'x', tier: undefined }, pending).kind).toBe('not_known')
  })

  it('reads the evidence environment’s cell: applied is not verified', () => {
    // ulid(1) is applied (not verified) on staging in the fixture stream.
    expect(evidenceOf(S, { slug: 'production', tier: 'prod' }, pending)).toEqual({
      kind: 'not_verified',
      from: 'staging',
      state: 'applied',
    })
  })

  it('says verified only for a passed verification of the same checksum', () => {
    const verified = {
      ...S,
      bundles: [
        {
          ...S.bundles[0],
          states: [
            {
              ...S.bundles[0]?.states[1],
              environment: 'staging',
              state: 'verified',
              checksum: `sha256:c1:${'a'.repeat(64)}`,
            },
          ],
        },
      ],
    } as unknown as MigrationStream
    const same = { migrationId: ulid(1), checksum: `sha256:c1:${'a'.repeat(64)}` }
    const other = { migrationId: ulid(1), checksum: `sha256:c1:${'f'.repeat(64)}` }
    expect(evidenceOf(verified, { slug: 'production', tier: 'prod' }, same).kind).toBe('verified')
    expect(evidenceOf(verified, { slug: 'production', tier: 'prod' }, other).kind).toBe(
      'other_checksum',
    )
    expect(evidenceWarns({ kind: 'verified', from: 'staging' })).toBe(false)
    expect(evidenceWarns({ kind: 'other_checksum', from: 'staging' })).toBe(true)
  })

  it('names production without an evidence environment, and an evidence target without a mirror', () => {
    const noFrom = {
      ...S,
      environments: S.environments.map((e) =>
        e.slug === 'production' ? { ...e, evidenceFrom: null } : e,
      ),
    } as MigrationStream
    expect(evidenceOf(noFrom, { slug: 'production', tier: 'prod' }, pending).kind).toBe(
      'no_environment',
    )
    const noMirror = {
      ...S,
      environments: S.environments.map((e) => (e.slug === 'staging' ? { ...e, mirror: null } : e)),
    } as MigrationStream
    expect(evidenceOf(noMirror, { slug: 'production', tier: 'prod' }, pending)).toEqual({
      kind: 'not_known',
      from: 'staging',
    })
  })
})

describe('what may be planned on an environment', () => {
  it('offers not applied and unknown bundles only, in stream order', () => {
    const production = candidatesFor(S, 'production')
    expect(production.map((c) => [c.migrationId, c.state])).toEqual([
      [ulid(1), 'not_applied'],
      [ulid(2), 'unknown'],
    ])
    // Staging holds both as applied or failed: nothing is offered there.
    expect(candidatesFor(S, 'staging')).toEqual([])
    expect(candidatesFor(S, 'nowhere')).toEqual([])
  })

  it('never offers a bundle whose id fails its grammar', () => {
    const hostile = {
      ...S,
      bundles: [{ ...S.bundles[0], migrationId: '../../x' }],
    } as unknown as MigrationStream
    expect(candidatesFor(hostile, 'production')).toEqual([])
  })

  it('opens on the environment that takes its evidence from the page’s, else the first with work', () => {
    expect(defaultDestination(S, 'staging')).toBe('production')
    expect(defaultDestination(S, 'production')).toBe('production')
    expect(defaultDestination(S)).toBe('production')
  })
})
