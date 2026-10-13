import { parseId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  BUILT_IN_ROLE_IDS,
  buildProblem,
  contractJsonSchema,
  isHighRiskAction,
  MCP_TOOL_LIST,
  RAW_STATEMENT_MAX_LENGTH,
  RawStatementQuerySchema,
  RawStatementSchema,
  ROUTE_LIST,
  rolePermissions,
  SCOPES,
} from '../src/index.ts'

/**
 * The raw statement view (Wave 8, owner decision S2; statement-redaction.md
 * §4): `diagnostics.read_sensitive`, a person in the Web App only,
 * re-authenticated within 15 minutes, one digest per request, a denial is a
 * security signal, and the text is bounded untrusted data.
 */
describe('statement.raw.get', () => {
  it('is a read of diagnostics.read_sensitive by a person in the Web App, re-authenticated within 15 minutes', () => {
    expect(ACTIONS['statement.raw.get']).toMatchObject({
      effect: 'read',
      subject: 'target',
      permission: { kind: 'fixed', permission: 'diagnostics.read_sensitive' },
      scope: { kind: 'fixed', scope: 'diagnostics.read_sensitive' },
      clientKinds: ['web'],
      humanOnly: true,
      reauthentication: true,
      reauthWithinSeconds: 900,
      operationKind: false,
      wave: '8',
    })
    expect(SCOPES['diagnostics.read_sensitive']).toMatchObject({ humanOnly: true })
    expect(MCP_TOOL_LIST.some((t) => t.action === 'statement.raw.get')).toBe(false)
    // A denial names a missing permission of a data-revealing read: audited as authz.denied.
    expect(isHighRiskAction('statement.raw.get')).toBe(true)
    // Viewer and developer do not hold it.
    const holders = BUILT_IN_ROLE_IDS.filter((r) =>
      rolePermissions(r).includes('diagnostics.read_sensitive'),
    )
    expect(holders).not.toContain('viewer')
    expect(holders).not.toContain('developer')
  })

  it('has the documented route: one digest in the path, the target in the query, no body', () => {
    const route = ROUTE_LIST.find((r) => r.operationId === 'getRawStatement')
    expect([route?.method, route?.path, route?.action]).toEqual([
      'get',
      '/statements/{digest}/raw',
      'statement.raw.get',
    ])
    expect(route?.body).toBeUndefined()
    expect(route?.errors).toEqual(
      expect.arrayContaining(['STATEMENT_NOT_AVAILABLE', 'REAUTH_REQUIRED']),
    )
    expect(route?.pathParams.safeParse({ digest: `sha256:${'a'.repeat(64)}` }).success).toBe(true)
    for (const digest of ['sha256:abc', `sha256:${'A'.repeat(64)}`, `${'a'.repeat(64)}`, 'a,b']) {
      expect(route?.pathParams.safeParse({ digest }).success, digest).toBe(false)
    }
    expect(RawStatementQuerySchema.safeParse({}).success).toBe(false)
    expect(RawStatementQuerySchema.safeParse({ target: 'acme/web/prod' }).success).toBe(true)
    expect(
      RawStatementQuerySchema.safeParse({ target: 'acme/web/prod', digests: ['x'] }).success,
    ).toBe(false)
  })

  it('answers bounded untrusted text, live, with where it was found', () => {
    const schema = contractJsonSchema(RawStatementSchema, { io: 'output' }) as {
      $defs?: Record<string, { properties?: Record<string, Record<string, unknown>> }>
      $ref?: string
    }
    const id = String(schema.$ref ?? '').replace('#/$defs/', '')
    const text = schema.$defs?.[id]?.properties?.['text']
    expect(text).toMatchObject({ maxLength: RAW_STATEMENT_MAX_LENGTH, untrusted: true })
    expect(RAW_STATEMENT_MAX_LENGTH).toBe(65_536)
    const ok = {
      targetId: 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
      digest: `sha256:${'b'.repeat(64)}`,
      text: 'SELECT 1',
      untrusted: true,
      truncated: false,
      redaction: { mode: 'literal', removed: 0 },
      origin: {
        view: 'pg_stat_activity',
        pid: 42,
        backendStart: '2026-10-13T10:00:00.000Z',
        queryStart: null,
      },
      source: 'live',
      observedAt: '2026-10-13T10:00:01.000Z',
    }
    expect(RawStatementSchema.safeParse(ok).success).toBe(true)
    expect(RawStatementSchema.safeParse({ ...ok, source: 'cached' }).success).toBe(false)
    expect(RawStatementSchema.safeParse({ ...ok, untrusted: false }).success).toBe(false)
    expect(
      RawStatementSchema.safeParse({ ...ok, text: 'x'.repeat(RAW_STATEMENT_MAX_LENGTH + 1) })
        .success,
    ).toBe(false)
  })

  it('refuses with STATEMENT_NOT_AVAILABLE and one of four reasons', () => {
    const parsed = parseId('req', 'req_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z')
    if (!parsed.ok) throw new Error('request id')
    const requestId = parsed.value
    for (const reason of [
      'not_held',
      'target_unreachable',
      'digest_mismatch',
      'extension_missing',
    ]) {
      const built = buildProblem('STATEMENT_NOT_AVAILABLE', { requestId, details: { reason } })
      expect(built.ok, reason).toBe(true)
      if (built.ok) expect(built.value.status).toBe(404)
    }
    expect(
      buildProblem('STATEMENT_NOT_AVAILABLE', { requestId, details: { reason: 'stale' } }).ok,
    ).toBe(false)
    expect(
      buildProblem('STATEMENT_NOT_AVAILABLE', {
        requestId,
        details: { reason: 'not_held', text: 'SELECT 1' },
      }).ok,
    ).toBe(false)
  })
})
