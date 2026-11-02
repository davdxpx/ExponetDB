import { OperationError } from '@exponetdb/operations'
import { describe, expect, it } from 'vitest'
import { errorCodeOf, problemResponse } from '../src/interfaces/http/request.ts'

/**
 * VC-066, VC-053, VC-036: a refusal the catalog knows answers its code, never 500. Details that do
 * not match the catalog, a Control Store outage and the internal operation codes were answered
 * `500 INTERNAL` with nothing in a journal.
 */
const REQUEST = 'req_01M6EQRJQVZSSRPXN13CT3ZBS2' as never
const PLAN = 'pln_01M6EQRJQVZSSRPXN13CT3ZBS2'

async function answer(error: unknown, context: Parameters<typeof problemResponse>[2] = {}) {
  const response = problemResponse(REQUEST, error, context)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('a refusal the catalog knows answers its code', () => {
  it('answers BACKUP_REQUIRED with the age the policy asked for (VC-066)', async () => {
    const r = await answer(new OperationError('BACKUP_REQUIRED', { details: { newerThan: 'P1D' } }))
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'BACKUP_REQUIRED', details: { newerThan: 'P1D' } })
  })

  it('says so in the journal when it has to fall back to INTERNAL (VC-066)', async () => {
    const downgraded: string[] = []
    const r = await answer(new OperationError('BACKUP_REQUIRED'), {
      onDowngrade: (code) => downgraded.push(code),
    })
    expect(r.status).toBe(500)
    expect(downgraded).toEqual(['BACKUP_REQUIRED'])
  })

  it.each([
    ['operation_kind_unknown', 'PLAN_STALE', 409],
    ['operation_state_changed', 'CONFLICT', 409],
    ['operation_transition_invalid', 'CONFLICT', 409],
    ['idempotency_in_progress', 'CONFLICT', 409],
  ] as const)(
    'maps the internal operation code %s to %s (VC-053)',
    async (internal, code, status) => {
      const error = new OperationError(internal, {
        changedBindings: [{ binding: 'kindVersion', actual: 'unknown' }],
      })
      expect(errorCodeOf(error)).toBe(code)
      const r = await answer(error, { planId: PLAN })
      expect(r.status).toBe(status)
      expect(r.body['code']).toBe(code)
    },
  )

  it('maps a Control Store outage to CONTROL_PLANE_DEGRADED, retryable (VC-036)', async () => {
    for (const code of [
      'control_store_unavailable',
      'control_store_timeout',
      'control_store_serialization_failure',
    ]) {
      const error = Object.assign(new Error('The Control Store is unreachable.'), {
        name: 'ControlStoreError',
        code,
      })
      const r = await answer(error)
      expect(r, code).toMatchObject({ status: 503, body: { code: 'CONTROL_PLANE_DEGRADED' } })
    }
  })

  it('maps an audit append that failed to CONTROL_PLANE_DEGRADED, and leaves an invalid event a bug (VC-042)', async () => {
    const failed = Object.assign(new Error('The audit event could not be written.'), {
      name: 'AuditWriteError',
      code: 'audit_append_failed',
    })
    // Every mutation fails when the audit chain cannot be written (a missing partition): the
    // Control Plane is degraded, not broken; the journal keeps the cause.
    expect(await answer(failed)).toMatchObject({
      status: 503,
      body: { code: 'CONTROL_PLANE_DEGRADED' },
    })
    const invalid = Object.assign(new Error('x'), {
      name: 'AuditWriteError',
      code: 'audit_event_invalid',
    })
    expect((await answer(invalid)).status).toBe(500)
  })

  it('leaves what is a bug as INTERNAL', async () => {
    const error = Object.assign(new Error('query failed'), {
      name: 'ControlStoreError',
      code: 'control_store_query_failed',
    })
    expect((await answer(error)).status).toBe(500)
  })
})
