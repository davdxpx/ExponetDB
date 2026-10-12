import { describe, expect, it } from 'vitest'
import {
  aggregate,
  type PlanContent,
  type Progress,
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
