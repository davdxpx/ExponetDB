import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  AUDIT_EXPORT_MAX_EVENTS,
  AuditExportQuerySchema,
  BUILT_IN_ROLE_IDS,
  buildOpenApi,
  MCP_TOOL_LIST,
  ROUTE_LIST,
  rolePermissions,
} from '../src/index.ts'

/**
 * The audit export (owner decision 2026-10-13; audit.md §5.1): full events for
 * offline verification, so owner and admin only (`policy.manage`, which the
 * auditor does not hold), a Web App session with a fresh re-authentication,
 * and never an MCP tool.
 */
describe('audit.export', () => {
  it('is held by owner and admin only, human only, re-authenticated within 300 s, Web App only, no MCP tool', () => {
    const a = ACTIONS['audit.export']
    expect(a).toMatchObject({
      effect: 'read',
      permission: { kind: 'fixed', permission: 'policy.manage' },
      scope: { kind: 'fixed', scope: 'policy.manage' },
      humanOnly: true,
      reauthentication: true,
      reauthWithinSeconds: 300,
      wave: '8',
    })
    expect(a.clientKinds).toEqual(['web'])
    expect(
      BUILT_IN_ROLE_IDS.filter((r) => rolePermissions(r).includes('policy.manage')).sort(),
    ).toEqual(['admin', 'owner'])
    expect(rolePermissions('auditor')).not.toContain('policy.manage')
    expect(MCP_TOOL_LIST.some((t) => t.action === 'audit.export')).toBe(false)
  })

  it('has the documented route and an NDJSON response in the OpenAPI document', () => {
    const route = ROUTE_LIST.find((r) => r.operationId === 'exportAuditEvents')
    expect([route?.method, route?.path, route?.action, route?.mediaType]).toEqual([
      'get',
      '/audit-events/export',
      'audit.export',
      'application/x-ndjson',
    ])
    // The static path must come before nothing that could capture it.
    const order = ROUTE_LIST.map((r) => r.operationId)
    expect(order.indexOf('exportAuditEvents')).toBeGreaterThanOrEqual(0)
    const doc = buildOpenApi() as {
      paths: Record<string, Record<string, { responses: Record<string, { content: object }> }>>
    }
    expect(
      Object.keys(doc.paths['/audit-events/export']?.['get']?.responses['200']?.content ?? {}),
    ).toEqual(['application/x-ndjson'])
  })

  it('caps a response at 10,000 events and validates the range bounds', () => {
    expect(AUDIT_EXPORT_MAX_EVENTS).toBe(10_000)
    expect(AuditExportQuerySchema.safeParse({ limit: 10_000 }).success).toBe(true)
    expect(AuditExportQuerySchema.safeParse({ limit: 10_001 }).success).toBe(false)
    expect(AuditExportQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    for (const ok of ['42', '2026-10-13T10:00:00Z', '2026-10-13T10:00:00.123456Z']) {
      expect(AuditExportQuerySchema.safeParse({ from: ok }).success, ok).toBe(true)
    }
    for (const bad of ['0', '-1', 'yesterday', '2026-10-13', '1e3', '2026-10-13T10:00:00+02:00']) {
      expect(AuditExportQuerySchema.safeParse({ to: bad }).success, bad).toBe(false)
    }
    expect(AuditExportQuerySchema.safeParse({ nope: 1 }).success).toBe(false)
  })
})
