import { describe, expect, it } from 'vitest'
import { loadBundleSet } from '../src/index.ts'

/**
 * Bundles that may already be applied somewhere are immutable: their apply
 * checksum binds the ledger rows of every installation, and their verify
 * digest decides whether a passed verification still counts. A change is a
 * new bundle, never an edit (control-database.md §5). The values are the
 * ones shipped with G2 (`main` at 62c819e) and with Wave 3A.
 */
const SHIPPED = {
  // Wave 2 (G2 accepted 2026-10-05)
  '01M46KHY80CWGMHV633DGSP8S8': [
    'sha256:c1:544f56c40b4a30534508b92cd5a831995e9ef1e002ac5fb8afdfdd70ce8b6e45',
    'sha256:c1:6d08efc620a22b9361d92d89532c2755bbe9fd7aed18fdf3cd7b8b4702ae2595',
  ],
  '01M46KHZ78WASHFHBKB2V0F0FD': [
    'sha256:c1:23f0950a425d677cfe2f275765ba3c9b449b171cd6faee84c02b64ab351c6205',
    'sha256:c1:951a99435c49ef9d857c065074f4ff854e5c1a8529262c6c47d594698fc1ff09',
  ],
  '01M46KJ06G9BHM1ZR7CDD2JZ2S': [
    'sha256:c1:95e6922801fc75f7f10db73d902ad96542524878d6fd2947e2e93230f1b7d9ae',
    'sha256:c1:3ba6dde1080f107b4fa7812e7f29dd8eb6a89acc108eee1c5b42b0bd6a66a636',
  ],
  '01M46KJ15RF3QGAA25E0VSAGFD': [
    'sha256:c1:c189b0329951ddad0acbce8282fe349febe0af29c433c36e39a80a2aa96782b2',
    'sha256:c1:7d36e6a6f6c9c471074dbf24978e0a9458b260255207073cc954b153ff6259c6',
  ],
  '01M46KJ250Q9MVCET3XSD0CVXH': [
    'sha256:c1:f28acfa87b1eb111e0554892e2e4d277911475ade3229d28f3d417eaf761b5cd',
    'sha256:c1:587a0145f622eaa24509a5b511e6bc1332c4441f30c2a99453b46d051f1d0fd3',
  ],
  '01M46KJ34887CQ6GFEX3SXMC2G': [
    'sha256:c1:dc9fc392be60ec19186e08210426de186c8c09ed49e27f676d6143191feb283a',
    'sha256:c1:16a40b28107f204c40390bb354d441850260673208270989f55332b09a1b1fe2',
  ],
} as const

describe('shipped Control Store bundles are immutable', () => {
  it('keeps the apply checksum and verify digest of every Wave 2 bundle', async () => {
    const set = await loadBundleSet()
    for (const [id, [checksum, verifyDigest]] of Object.entries(SHIPPED)) {
      const bundle = set.bundles.find((b) => b.id === id)
      expect(bundle, id).toBeDefined()
      expect(bundle?.digests.checksum, id).toBe(checksum)
      expect(bundle?.digests.verifyDigest, id).toBe(verifyDigest)
    }
  })

  it('orders the Wave 3A bundles after the Wave 2 head through dependsOn', async () => {
    const set = await loadBundleSet()
    const order = set.bundles.map((b) => b.name)
    expect(order.slice(0, 6)).toEqual([
      'control-foundation',
      'process-health',
      'audit-chain',
      'secrets-store',
      'policy-settings',
      'operations-engine',
    ])
    expect(order.slice(6)).toEqual(['auth-identity', 'access-control', 'plan-approvals'])
    const approvals = set.bundles.find((b) => b.name === 'plan-approvals')
    expect(approvals?.dependsOn).toContain('01M46KJ34887CQ6GFEX3SXMC2G')
  })
})
