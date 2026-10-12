import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBundleSet } from '../src/index.ts'

/**
 * Bundles that may already be applied somewhere are immutable: their apply
 * checksum binds the ledger rows of every installation, and their verify
 * digest decides whether a passed verification still counts. A change is a
 * new bundle, never an edit (control-database.md §5). The values are the
 * ones shipped with G2 (`main` at 62c819e, accepted 2026-10-05), with
 * Wave 3A (`main` at 06613bc, G3A accepted 2026-10-06), with Wave 3B
 * (baseline 548c9a7, the final G3B hardening; G3B accepted 2026-10-06) and
 * with Wave 4 (baseline 04b2e77, the merge of the G4 corrections; G4
 * accepted 2026-10-07 under the owner's conditional delegation), with
 * Wave 5 and Wave 6 (baseline c7e8bc7, the merge of `davdxpx/ExponetDB#14`;
 * G5 and G6 accepted by the owner on 2026-10-12).
 *
 * The same pins are listed in `frozen-bundles.json`, which
 * `bun run golden:history <base>` guards against the base commit: an entry
 * of the base can be neither changed nor removed, and the directory of a
 * listed bundle must stay byte-identical to the base. Editing a frozen
 * bundle together with these pins therefore still fails in CI.
 */
const FROZEN = {
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
  // Wave 3A (G3A accepted 2026-10-06, baseline 06613bcdd7c153466356c62298ae9fd847359a57)
  '01M46VP9A1J9EGS4ZYVCFC16NQ': [
    'sha256:c1:ec15f71861dd36cec4b71cc7f2811e720a68b29b8888043befd1fbc8a4a67f09',
    'sha256:c1:71f809012f8c49979b4c503da7bdf2059cab91261ca53d2d647149a2a667a94c',
  ],
  '01M46VP9A27KW2NNSGCB14RTEE': [
    'sha256:c1:e7b2d291818152ecb15043d952e8e21cee5d9051bf0d7c3c798051677351943f',
    'sha256:c1:d2a7bf25bd2db9e5215a4489cca4c110a25ff7355eb3067b9f571e1d2709f7ae',
  ],
  '01M46VP9A3AH63EHFZB448Y6MA': [
    'sha256:c1:5b841640615db28c9e99294ad6c829074e283f9756766a1d53da01133cd21765',
    'sha256:c1:2ed808bc3dbc0486b01d4e7952a011736d831f2586db032876ce4ab01f4a8e4d',
  ],
  // Wave 3B (G3B accepted 2026-10-06, baseline 548c9a765e43cc1eceacdefd39ac50d47bb80347)
  '01M47XQ56MW0JQX3J715X2GDB8': [
    'sha256:c1:a71c7a43770e4d2f259bd1af4731423c6c30d713b88057d545a3e32cc5f35a6e',
    'sha256:c1:b600ad98be1266ff2e6bf6469ced13e114492078b4164a580aa4766768dcb67a',
  ],
  // Wave 4 (G4 accepted 2026-10-07 by owner delegation, baseline 04b2e7705df8047aa89f4c28670cfb75a4e11bea)
  '01M48WRFNFYAY62E1146END05N': [
    'sha256:c1:c76599cc84053b0cd265b1ede9f138ea59dcff3d719ac7959d2bdd59662e5777',
    'sha256:c1:3660f20b04df3822627b6ccd79289aef85416bbf4ffa4570e7615214b3dc098f',
  ],
  '01M48WRFNGYF5WH0884N169FNH': [
    'sha256:c1:ab70507e38f03a3e06086d6bea8b0280aea21af19cf82481f57115b105c2e270',
    'sha256:c1:fc9f1998499337675c77fbfa19eab6841be8ba505d0a28117b9a9b1d46120a49',
  ],
  // Wave 5 (G5 accepted 2026-10-12 by the owner, baseline c7e8bc763e7c886b8826930dead16548dc482ac4)
  '01M49K5NQ8ZB4W2T6Y3H7RXJMD': [
    'sha256:c1:58d1a2ddb0bdce2a66b45f2ac499894e671abc2b4dc93c8fb377a7b288bfd483',
    'sha256:c1:8e47e8db30d83f84b9714b798fdb1926ffea44301b116ec1ed72cffb06103338',
  ],
  '01M4DSPKRQD52Y8E9MKCYKWVFW': [
    'sha256:c1:337bccd5b79371708b42f1172c28fa94c09a30fd67feebc099ce9e44fd1c3b55',
    'sha256:c1:68000e0bd70e3344e841f231e05256c5c7d41c8b2c17b42b8ae05187fa1c6c18',
  ],
  // Wave 6 (G6 accepted 2026-10-12 by the owner, baseline c7e8bc763e7c886b8826930dead16548dc482ac4)
  '01M4QEE7JX03XAZJKZ2MRT8JJT': [
    'sha256:c1:708f9e22065eb4c3bf4130083050b9a72f48f0cc3e1e4f6970a42c78f88d6d68',
    'sha256:c1:21f18cbf6cda17370cc65bd6858e5885f2bd3b751465746ab3921c49ffe0fec6',
  ],
  '01M4QN37EYQ6X0NFPAQRPK5FAG': [
    'sha256:c1:06e7cdb00bbded665e7ba42a27b27f5056e0e356bb4e53555a058780328f5f2e',
    'sha256:c1:5442bc6249911e4f0531f7284958e6feccd6d1cdc1f7457517cc8475358a18c5',
  ],
  '01M4QPP4T3E31ANKDVSR7T3YHS': [
    'sha256:c1:d65ebf049ee2376a8290182106b9dc3b52c38cd3c8c0f4910ea049412ee8c79d',
    'sha256:c1:480bb284c528f483d38946aefb30a1ea8e8222b211d07bfa07d7cf15c0442d0b',
  ],
  '01M4QT02MQ05WZ8J29C134Y45A': [
    'sha256:c1:251ea0090a7181328adc72e2b74ac85e6a84c42381e75d25301e2c671b94fdd2',
    'sha256:c1:d158ea431ba21f08914cae45a024b47fcab3ee38cff9dfa797a2f87294f510e2',
  ],
  '01M4R2T03VG6F43SEKX6F5ST5G': [
    'sha256:c1:3436c71d971171d6bded4f1e6873547c8548dba181bdd87294400fc4c00313d4',
    'sha256:c1:be910b66844eb150f3c80d9b6d018d53b52687ed4d6faaa2eafd30840147cea8',
  ],
  '01M4R53PV1XDVSGDSVN86DQ3JB': [
    'sha256:c1:06fde9ae687f0692d86ed66ae73f06531374771a853e5cf7cdb0d2bd7fb411fe',
    'sha256:c1:87ac9628f64d9c8074ecc33d369c5457bda9f22d206258ecd12fcdde7aa90715',
  ],
  '01M4R66846BD63S51NS15EZKB1': [
    'sha256:c1:166e8cbea86a2352fef420b39f617fb0082be38ca7b3e40d8d4373cbf5d8454d',
    'sha256:c1:0c5d079c8520cc2821b7f2caff324013253ddac9be42da8b1544a04b22aaf290',
  ],
} as const

const WAVE_2 = [
  'control-foundation',
  'process-health',
  'audit-chain',
  'secrets-store',
  'policy-settings',
  'operations-engine',
]
const WAVE_3A = ['auth-identity', 'access-control', 'plan-approvals']
const WAVE_3B = ['oauth-delegation']
const WAVE_4 = ['registry', 'observation']
// Wave 5: the node agent's control plane, then the gateway's admission of
// completions (Wave 5 correction F1).
const WAVE_5 = ['nodes', 'node-gateway-admission']
// Wave 6: the migration engine's records, break-glass grants, import reports,
// CLI step-ups (ADR-0026), the worker's authority re-check (E27), operator
// verification retries (E10), migration baselines for drift.
const WAVE_6 = [
  'migration-engine',
  'break-glass',
  'legacy-import',
  'step-up',
  'operation-authority',
  'verification-retry',
  'migration-baselines',
]

interface FrozenEntry {
  readonly id: string
  readonly name: string
  readonly checksum: string
  readonly verifyDigest: string
}

function frozenList(): FrozenEntry[] {
  const doc: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'frozen-bundles.json'), 'utf8'),
  )
  const bundles =
    typeof doc === 'object' && doc !== null && 'bundles' in doc ? doc.bundles : undefined
  if (!Array.isArray(bundles)) {
    throw new Error('frozen-bundles.json has no bundles array')
  }
  return bundles.map((b: unknown) => {
    const entry = typeof b === 'object' && b !== null ? b : {}
    const text = (key: string): string => {
      const v = Object.getOwnPropertyDescriptor(entry, key)?.value
      if (typeof v !== 'string') {
        throw new Error(`frozen-bundles.json: ${key} missing`)
      }
      return v
    }
    return {
      id: text('id'),
      name: text('name'),
      checksum: text('checksum'),
      verifyDigest: text('verifyDigest'),
    }
  })
}

describe('shipped Control Store bundles are immutable', () => {
  it('keeps the apply checksum and verify digest of every Wave 2, 3A, 3B, 4, 5 and 6 bundle', async () => {
    const set = await loadBundleSet()
    for (const [id, [checksum, verifyDigest]] of Object.entries(FROZEN)) {
      const bundle = set.bundles.find((b) => b.id === id)
      expect(bundle, id).toBeDefined()
      expect(bundle?.digests.checksum, id).toBe(checksum)
      expect(bundle?.digests.verifyDigest, id).toBe(verifyDigest)
    }
    const names = set.bundles.filter((b) => Object.hasOwn(FROZEN, b.id)).map((b) => b.name)
    expect(names).toEqual([...WAVE_2, ...WAVE_3A, ...WAVE_3B, ...WAVE_4, ...WAVE_5, ...WAVE_6])
  })

  it('lists exactly the pinned bundles in frozen-bundles.json, with the same digests', async () => {
    const set = await loadBundleSet()
    const list = frozenList()
    expect(list.map((e) => e.id)).toEqual(Object.keys(FROZEN))
    for (const entry of list) {
      const pins: unknown = Object.getOwnPropertyDescriptor(FROZEN, entry.id)?.value
      expect([entry.checksum, entry.verifyDigest], entry.id).toEqual(pins)
      expect(set.bundles.find((b) => b.id === entry.id)?.name, entry.id).toBe(entry.name)
    }
  })

  it('orders every later bundle after the frozen ones through dependsOn', async () => {
    const set = await loadBundleSet()
    const order = set.bundles.map((b) => b.name)
    expect(order.slice(0, 6)).toEqual(WAVE_2)
    expect(order.slice(6, 9)).toEqual(WAVE_3A)
    expect(order.slice(9, 10)).toEqual(WAVE_3B)
    expect(order.slice(10, 12)).toEqual(WAVE_4)
    expect(order.slice(12, 14)).toEqual(WAVE_5)
    expect(order.slice(14, 21)).toEqual(WAVE_6)
    const approvals = set.bundles.find((b) => b.name === 'plan-approvals')
    expect(approvals?.dependsOn).toContain('01M46KJ34887CQ6GFEX3SXMC2G')
  })
})
