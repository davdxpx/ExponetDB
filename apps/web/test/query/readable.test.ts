import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/lib/api/errors.ts'
import { classifyFailure, isRetryable } from '../../src/lib/query/errors.ts'
import { toReadable } from '../../src/lib/query/readable.ts'

const NOW = Date.parse('2026-10-13T12:00:00.000Z')
const now = () => NOW

describe('toReadable: a failed read is never empty', () => {
  it('is loading while pending without data', () => {
    expect(
      toReadable({ data: undefined, error: null, isError: false, dataUpdatedAt: 0 }, { now }),
    ).toEqual({
      state: 'loading',
    })
  })

  it('is failed, with the catalog message and code, when the first read fails', () => {
    const error = new ApiError('TARGET_UNREACHABLE', 503, 'ExponetDB cannot reach the target.')
    expect(
      toReadable<string[]>({ data: undefined, error, isError: true, dataUpdatedAt: 0 }, { now }),
    ).toEqual({
      state: 'failed',
      error: { code: 'TARGET_UNREACHABLE', message: 'ExponetDB cannot reach the target.' },
    })
  })

  it('keeps an empty list ready only after a successful read', () => {
    const r = toReadable<string[]>(
      { data: [], error: null, isError: false, dataUpdatedAt: NOW - 1_000 },
      { now },
    )
    expect(r).toEqual({
      state: 'ready',
      value: [],
      source: 'live',
      observedAt: new Date(NOW - 1_000).toISOString(),
    })
  })

  it('turns data whose refresh failed into stale data with the failure', () => {
    const error = new ApiError('NETWORK', 0, 'unreachable')
    const r = toReadable({ data: ['a'], error, isError: true, dataUpdatedAt: NOW - 5_000 }, { now })
    expect(r).toMatchObject({
      state: 'stale',
      value: ['a'],
      source: 'cached',
      error: { code: 'NETWORK' },
    })
  })

  it('turns data older than the limit into stale data with its age', () => {
    const r = toReadable(
      { data: ['a'], error: null, isError: false, dataUpdatedAt: NOW - 120_000 },
      { now },
    )
    expect(r).toMatchObject({ state: 'stale', observedAt: new Date(NOW - 120_000).toISOString() })
  })

  it('takes source and time from the server when the payload carries them', () => {
    const payload = {
      state: 'healthy',
      freshness: { source: 'sampled', observedAt: '2026-10-13T11:59:50.000Z' },
    }
    expect(
      toReadable({ data: payload, error: null, isError: false, dataUpdatedAt: NOW }, { now }),
    ).toMatchObject({
      state: 'ready',
      source: 'sampled',
      observedAt: '2026-10-13T11:59:50.000Z',
    })
    const old = { source: 'agent_reported', observedAt: '2026-10-13T11:00:00.000Z' }
    expect(
      toReadable({ data: old, error: null, isError: false, dataUpdatedAt: NOW }, { now }),
    ).toMatchObject({
      state: 'stale',
      source: 'agent_reported',
    })
  })

  it('names what is missing in a partial answer', () => {
    const r = toReadable(
      { data: { items: [1] }, error: null, isError: false, dataUpdatedAt: NOW },
      { now, missing: () => ['indexes: the observer role cannot read pg_index on this version'] },
    )
    expect(r).toMatchObject({
      state: 'partial',
      missing: ['indexes: the observer role cannot read pg_index on this version'],
    })
  })
})

describe('failure classification', () => {
  it('maps codes and statuses to the named states', () => {
    expect(classifyFailure(new ApiError('NETWORK', 0, 'x')).kind).toBe('network')
    expect(classifyFailure(new ApiError('SESSION_EXPIRED', 401, 'x')).kind).toBe('session')
    expect(classifyFailure(new ApiError('FORBIDDEN', 403, 'x')).kind).toBe('not_permitted')
    expect(classifyFailure(new ApiError('PLAN_NOT_FOUND', 404, 'x')).kind).toBe('not_found')
    expect(classifyFailure(new ApiError('RATE_LIMITED', 429, 'x')).kind).toBe('rate_limited')
    expect(classifyFailure(new ApiError('UNAVAILABLE', 503, 'x')).kind).toBe('unavailable')
    expect(classifyFailure(new ApiError('VALIDATION_FAILED', 422, 'x')).kind).toBe('invalid')
    expect(classifyFailure(new ApiError('INTERNAL', 500, 'x')).kind).toBe('failed')
    expect(classifyFailure(new Error('boom'))).toEqual({
      kind: 'failed',
      code: 'UNKNOWN',
      message: 'The read failed.',
    })
  })

  it('retries only unreachable and unavailable reads', () => {
    expect(isRetryable(new ApiError('NETWORK', 0, 'x'))).toBe(true)
    expect(isRetryable(new ApiError('UNAVAILABLE', 503, 'x'))).toBe(true)
    expect(isRetryable(new ApiError('FORBIDDEN', 403, 'x'))).toBe(false)
    expect(isRetryable(new ApiError('INTERNAL', 500, 'x'))).toBe(false)
  })
})
