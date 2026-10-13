import { verifyAuditChain } from '@exponetdb/audit'
import type { Clock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  InstallationKeys,
  MCP_KEY_REFRESH_MS,
  type McpKeyPurpose,
  rotateMcpKey,
} from '../src/index.ts'
import { type Harness, harness } from './support/flows.ts'

/**
 * Rotation of the MCP installation keys (Wave 7 order §30) against
 * PostgreSQL 17 with the serve login: a new version of the same secret,
 * audited without key material; a serve process reads the newest two
 * versions again after the refresh interval, so the version before the
 * newest still opens and an older one does not.
 */
let h: Harness
let nowMs = Date.parse('2026-10-13T08:00:00Z')
const clock: Clock = { nowMs: () => nowMs }

beforeAll(async () => {
  h = await harness('exdb_it_auth_keys')
}, 120_000)

afterAll(async () => {
  await h?.db.drop()
})

/** The audit events of an action, parsed (stored as their canonical JSON text). */
async function auditRows(db: Harness['db'], action: string): Promise<Record<string, unknown>[]> {
  const { rows } = await db.asSuperuser((c) =>
    c.query<{ event: unknown }>(
      'SELECT event FROM audit.audit_events WHERE action = $1 ORDER BY seq',
      [action],
    ),
  )
  return rows.map((r) =>
    typeof r.event === 'string'
      ? (JSON.parse(r.event) as Record<string, unknown>)
      : (r.event as Record<string, unknown>),
  )
}

describe('MCP installation keys', () => {
  it('rotate: a new version seals after the refresh, the previous still opens, an older one is retired', async () => {
    const keys = new InstallationKeys(h.deps.store, h.keyring, clock)
    const purpose: McpKeyPurpose = 'mcp.request_state_key'
    const first = await keys.mcpKeys(purpose)
    expect(first.current.version).toBe(1)
    expect(first.previous).toBeUndefined()
    const v1 = Buffer.from(first.current.key)

    const rotated = await rotateMcpKey(h.deps.store, h.keyring, clock, purpose)
    expect(rotated).toEqual({ purpose, version: 2 })
    // Until the refresh the process keeps its set; then it reads both versions.
    expect((await keys.mcpKeys(purpose)).current.version).toBe(1)
    nowMs += MCP_KEY_REFRESH_MS
    const second = await keys.mcpKeys(purpose)
    expect(second.current.version).toBe(2)
    expect(second.previous?.version).toBe(1)
    expect(second.previous?.key.equals(v1)).toBe(true)
    expect(second.current.key.equals(v1)).toBe(false)
    expect(second.current.key.length).toBe(32)
    // Another serve process (a new instance) agrees at once.
    const other = new InstallationKeys(h.deps.store, h.keyring, clock)
    expect((await other.mcpKey(purpose)).equals(second.current.key)).toBe(true)

    await rotateMcpKey(h.deps.store, h.keyring, clock, purpose)
    nowMs += MCP_KEY_REFRESH_MS
    const third = await keys.mcpKeys(purpose)
    expect([third.current.version, third.previous?.version]).toEqual([3, 2])
    expect([third.current.key, third.previous?.key].some((k) => k?.equals(v1))).toBe(false)

    // The other MCP key is its own secret, untouched by this rotation.
    expect((await keys.mcpKeys('mcp.cursor_key')).current.version).toBe(1)

    const rotations = await auditRows(h.db, 'auth.installation_key.rotate')
    expect(rotations.map((r) => r['changes'])).toEqual([
      { purpose, version: 2 },
      { purpose, version: 3 },
    ])
    expect(rotations.map((r) => (r['actor'] as { label?: string }).label)).toEqual([
      'system:maintenance',
      'system:maintenance',
    ])
    // No key material anywhere in the audit: no version's bytes in any encoding.
    const { rows } = await h.db.asSuperuser((c) => c.query('SELECT event FROM audit.audit_events'))
    const all = JSON.stringify(rows)
    for (const k of [v1, second.current.key, third.current.key]) {
      expect(all).not.toContain(k.toString('hex'))
      expect(all).not.toContain(k.toString('base64'))
      expect(all).not.toContain(k.toString('base64url'))
    }
    expect((await verifyAuditChain(h.deps.store)).ok).toBe(true)
  })

  it('rotates only the MCP keys, and a key not created yet is created instead', async () => {
    await expect(
      rotateMcpKey(h.deps.store, h.keyring, clock, 'audit.pseudonym_key' as McpKeyPurpose),
    ).rejects.toMatchObject({ code: 'auth_key_unavailable' })
    const fresh = await harness('exdb_it_auth_keys2')
    try {
      expect(await rotateMcpKey(fresh.deps.store, fresh.keyring, clock, 'mcp.cursor_key')).toEqual({
        purpose: 'mcp.cursor_key',
        version: 1,
      })
      expect(await auditRows(fresh.db, 'auth.installation_key.rotate')).toEqual([])
      expect(
        (await auditRows(fresh.db, 'auth.installation_key.create')).map((r) => r['changes']),
      ).toEqual([{ purpose: 'mcp.cursor_key' }])
    } finally {
      await fresh.db.drop()
    }
  })
})
