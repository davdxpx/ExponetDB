/**
 * Block R, tester R3, TC-066: the Web polish items that run without a browser (W-04, W-08, W-10).
 * Copy to apps/web/test/r3-web-probes.test.ts; `bunx vitest run test/r3-web-probes.test.ts` in apps/web.
 */
import { describe, it } from 'vitest'
import { ledgerCounts } from '../src/features/migrations/history-model.ts'
import { t } from '../src/lib/i18n/i18n.ts'
import { titleOf } from '../src/app/title.ts'

const out = (name: string, data: unknown) => process.stdout.write(`R3PROBE ${name} ${JSON.stringify(data)}\n`)

describe('TC-066 probes', () => {
  it('W-04: the migration counters add up', () => {
    const entry = (i: number, v: { status: string; superseded?: boolean }) => ({
      migrationId: `01M5X2X3ARA75KSKZPANYYEH${String(i).padStart(2, '0')}`,
      name: `m${i}`,
      origin: 'exponetdb',
      appliedAt: '2026-10-01T00:00:00Z',
      verification: v,
    })
    const applied = [
      ...Array.from({ length: 6 }, (_, i) => entry(i, { status: 'passed' })),
      entry(6, { status: 'pending' }),
      entry(7, { status: 'failed' }),
      entry(8, { status: 'passed', superseded: true }),
      entry(9, { status: 'passed', superseded: true }),
    ]
    const c = ledgerCounts({ applied, pending: [] } as never)
    out('tc066.w04', { ...c, shownInStrip: c.verified + c.verificationPending + c.failed, appliedCounter: c.applied })
  })
  it('W-08: plurals', () => {
    out('tc066.w08', [
      t('infra.retire.group.cluster', { count: 1 }),
      t('infra.retire.group.node', { count: 1 }),
      t('infra.retire.with.endpoint', { count: 1 }),
      t('projects.count', { total: 1 } as never),
    ])
  })
  it('W-10: document titles', () => {
    out('tc066.w10', {
      unknownTarget: titleOf('/t/nope/nope/nope', []),
      invalidSlug: titleOf('/t/BAD SLUG/x/y', []),
      access: titleOf('/access', []),
      settings: titleOf('/settings', []),
    })
  })
})
