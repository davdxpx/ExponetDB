import { describe, expect, it } from 'vitest'
import { compareLedger } from '../src/divergence.ts'
import {
  aggregate,
  type PlanContent,
  type Progress,
  resumeLog,
  resumeStart,
  satisfies,
  serverVersion,
  stateChanges,
} from '../src/index.ts'

describe('version ranges of requires', () => {
  it('compares dotted numeric versions and fails closed on anything else', () => {
    expect(satisfies('>=16 <19', '17.2')).toBe(true)
    expect(satisfies('>=16 <19', '19.0')).toBe(false)
    expect(satisfies('=16', '16.4')).toBe(true)
    expect(satisfies('16', '17.0')).toBe(false)
    expect(satisfies('>=0.7.0', '0.8.1')).toBe(true)
    expect(satisfies('>=0.7.0', '0.6.9')).toBe(false)
    expect(satisfies('>=1.5', '1.5.1-beta')).toBe(false)
    expect(satisfies('nonsense', '1.0')).toBe(false)
    expect(serverVersion(170002)).toBe('17.2')
    expect(serverVersion(160014)).toBe('16.14')
  })
})

const row = (position: number, over: Partial<Progress>): Progress => ({
  position,
  migrationId: `01M4A0000000000000000000${position}0`,
  name: 'm',
  applyOutcome: 'applied',
  verificationOutcome: 'passed',
  statementIndex: null,
  sqlstate: null,
  errorCode: null,
  gate: null,
  ...over,
})

describe('the operation verification outcome', () => {
  it('is passed only when every planned migration was applied and passed', () => {
    expect(aggregate([row(0, {}), row(1, {})], 2)).toBe('passed')
    expect(
      aggregate(
        [
          row(0, {}),
          row(1, { applyOutcome: 'not_applied', verificationOutcome: 'not_applicable' }),
        ],
        2,
      ),
    ).toBe('partial')
    expect(aggregate([row(0, { verificationOutcome: 'failed' })], 2)).toBe('failed')
    expect(aggregate([row(0, { verificationOutcome: 'error' })], 1)).toBe('error')
    // An applied migration whose verification never ran is not passed.
    expect(aggregate([row(0, { verificationOutcome: 'pending' })], 1)).toBe('error')
  })
})

describe('bindings against the target now', () => {
  const content = {
    target: { serverVersionNum: 170002, databaseOid: '16384' },
    expectedState: {
      schemaFingerprint: `fp1:17:${'a'.repeat(64)}`,
      ledgerStateHash: `sha256:ls1:${'b'.repeat(64)}`,
      extensions: { vector: '0.8.0' },
      executionRoles: {},
    },
  } as unknown as PlanContent
  const same = {
    ledgerStateHash: `sha256:ls1:${'b'.repeat(64)}`,
    fingerprint: `fp1:17:${'a'.repeat(64)}`,
    serverVersionNum: 170002,
    extensions: { vector: '0.8.0' },
    databaseOid: '16384',
  }
  it('names every binding that changed', () => {
    expect(stateChanges(content, same)).toEqual([])
    expect(
      stateChanges(content, {
        ...same,
        ledgerStateHash: `sha256:ls1:${'c'.repeat(64)}`,
        fingerprint: `fp1:17:${'d'.repeat(64)}`,
        serverVersionNum: 170003,
        extensions: { vector: '0.8.1' },
        databaseOid: '99999',
      }).map((b) => b.binding),
    ).toEqual(['ledger', 'fingerprint', 'server_version', 'database', 'extensions'])
    expect(
      stateChanges(content, { ...same, extensions: { vector: '0.8.0', pg_trgm: '1.6' } }).map(
        (b) => b.binding,
      ),
    ).toEqual(['extensions'])
  })
})

describe('the event log of an incomplete non-transactional start', () => {
  const OP1 = 'op_01M4A000000000000000000001'
  const OP2 = 'op_01M4A000000000000000000002'
  let seq = 0
  const ev = (event: string, operationId: string, detail: Record<string, unknown> = {}) => ({
    seq: String(++seq),
    at: '2026-10-12T00:00:00Z',
    migrationId: '01M4A000000000000000000000',
    operationId,
    event,
    detail: detail as never,
  })

  it('finds the first statement without a done event and the failure recorded for it', () => {
    seq = 0
    const log = resumeLog([
      ev('nontx_started', OP1, { statements: 3 }),
      ev('nontx_statement_done', OP1, { statementIndex: 0 }),
      ev('nontx_failed', OP1, { statementIndex: 1, sqlstate: '55P03' }),
    ])
    expect(log).toMatchObject({ originalOperationId: OP1, next: 1, failed: { sqlstate: '55P03' } })
    expect(log?.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    if (log === null) throw new Error('log')
    expect(resumeStart(log, 'failed_without_effect', 3, false)).toBe(1)
    expect(resumeStart(log, 'present', 3, false)).toBe(2)
    expect(resumeStart(log, 'invalid_index', 3, false)).toBeNull()
    expect(resumeStart(log, 'invalid_index', 3, true)).toBe(1)
    expect(resumeStart(log, 'ambiguous', 3, true)).toBeNull()
    expect(resumeStart(log, 'unreadable', 3, true)).toBeNull()
  })

  it('treats a crash gap as no recorded failure: the readback decides, never a blind re-run', () => {
    seq = 0
    const log = resumeLog([
      ev('nontx_started', OP1),
      ev('nontx_statement_done', OP1, { statementIndex: 0 }),
    ])
    expect(log).toMatchObject({ next: 1, failed: null })
  })

  it('follows a resume that failed again, and an L0 failure after the last statement', () => {
    seq = 0
    const events = [
      ev('nontx_started', OP1),
      ev('nontx_statement_done', OP1, { statementIndex: 0 }),
      ev('nontx_failed', OP1, { statementIndex: 1, sqlstate: '55P03' }),
      ev('nontx_statement_done', OP2, { statementIndex: 1, resume: { of: OP1 } }),
      ev('nontx_failed', OP2, { statementIndex: 2, gate: { layer: 'L0' } }),
    ]
    const log = resumeLog(events)
    expect(log).toMatchObject({
      originalOperationId: OP1,
      next: 2,
      failed: { gate: { layer: 'L0' } },
    })
    if (log === null) throw new Error('log')
    expect(resumeStart(log, 'all_done', 2, false)).toBe(2)
    // Any new event changes the digest the plan bound.
    const later = resumeLog([...events, ev('nontx_failed', OP2, { statementIndex: 2 })])
    expect(later?.digest).not.toBe(log.digest)
  })

  it('has nothing to resume once closed, recorded or never started', () => {
    seq = 0
    expect(resumeLog([])).toBeNull()
    expect(
      resumeLog([
        ev('nontx_started', OP1),
        ev('nontx_failed', OP1, { statementIndex: 0, sqlstate: '22012' }),
        ev('ledger_reconciled', OP1, { resolution: 'not_applied' }),
      ]),
    ).toBeNull()
    expect(
      resumeLog([
        ev('nontx_started', OP1),
        ev('nontx_statement_done', OP1, { statementIndex: 0 }),
        ev('applied', OP1),
      ]),
    ).toBeNull()
    // A later start after a closed one is incomplete again.
    expect(
      resumeLog([ev('nontx_started', OP1), ev('ledger_reconciled', OP1), ev('nontx_started', OP2)]),
    ).toMatchObject({ originalOperationId: OP2, next: 0 })
  })
})

describe('the ledger against its mirror (ledger.md §5)', () => {
  const row = (migrationId: string, checksum = 'c', operationId = 'op_a') => ({
    migrationId,
    checksum,
    operationId,
  })

  it('agrees when every mirrored row is live unchanged, and heals rows a known operation wrote', () => {
    expect(compareLedger([row('A')], [row('A')], new Set())).toBeNull()
    // Committed on the target, crashed before the mirror: the operation is known.
    expect(
      compareLedger([row('A')], [row('A'), row('B', 'c', 'op_b')], new Set(['op_b'])),
    ).toBeNull()
  })

  it('names missing, changed and unrecorded rows', () => {
    expect(
      compareLedger(
        [row('A'), row('B'), row('C')],
        [row('A', 'other'), row('C', 'c', 'op_x'), row('D', 'c', 'op_unknown')],
        new Set(['op_a']),
      ),
    ).toEqual({ missing: ['B'], checksumDiffers: ['A', 'C'], unrecorded: ['D'] })
  })

  it('names at most 16 rows per class', () => {
    const live = Array.from({ length: 40 }, (_, i) => row(`X${i}`, 'c', 'op_unknown'))
    expect(compareLedger([], live, new Set())?.unrecorded).toHaveLength(16)
  })
})
