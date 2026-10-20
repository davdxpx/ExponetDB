import { World } from '../target/support.tsx'

export { mountApp } from '../target/support.tsx'

/** A 26-character ULID body that passes the id grammar. */
export const ulid = (n: number): string => `01M4S9${String(n).padStart(20, '0')}`

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

export const BIDI = '‮'
export const ZERO_WIDTH = '​'
export const HOSTILE = `<script>alert(1)</script>${BIDI}evil${ZERO_WIDTH}`

/** One finding as `GET /findings` sends it (a finding with the id and path of its target). */
export function finding(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `fnd_${ulid(n)}`,
    kind: 'drift',
    code: 'schema_drift',
    severity: 'warning',
    subject: { targetId: `tgt_${ulid(2)}`, clusterId: null, nodeId: null },
    summary: `Table orders_${n} differs from the expected schema`,
    state: 'open',
    occurrences: 3,
    object: `public.orders_${n}`,
    securityRelevant: false,
    resolution: null,
    firstSeenAt: ago(86_400_000),
    lastSeenAt: ago(60_000),
    resolvedAt: null,
    targetId: `tgt_${ulid(2)}`,
    targetPath: 'shop/platform/staging',
    ...over,
  }
}

/** A world whose `GET /findings` answers one page of `items` (and, when given, a cursor). */
export function worldWithFindings(
  items: readonly unknown[] = [
    finding(1),
    finding(2, {
      kind: 'health',
      code: 'disk_low',
      severity: 'critical',
      targetPath: 'billing/api/live',
    }),
  ],
  nextCursor: string | null = null,
): World {
  const world = new World()
  world.globalFindings = () => ({ items, nextCursor })
  return world
}

export { World }
