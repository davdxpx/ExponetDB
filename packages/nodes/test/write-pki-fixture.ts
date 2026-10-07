import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFixture, INSTALLATION, NODE, PKI_TIME, SERVER_NAME } from './pki-fixture.ts'

// Writes tooling/fixtures/node-pki: `bun packages/nodes/test/write-pki-fixture.ts`.
const dir = join(import.meta.dirname, '..', '..', '..', 'tooling', 'fixtures', 'node-pki')
const certs = buildFixture()
for (const c of certs) {
  writeFileSync(join(dir, `${c.name}.der`), c.der)
}
const manifest = {
  comment:
    'Agent PKI test fixture written by packages/nodes/test/write-pki-fixture.ts; test keys from fixed seeds (32 times the seed byte), never real key material.',
  time: PKI_TIME.toISOString(),
  installationId: INSTALLATION,
  nodeId: NODE,
  serverName: SERVER_NAME,
  certificates: certs.map((c) => ({ name: c.name, profile: c.profile, seed: c.seed })),
}
writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${certs.length} certificates`)
