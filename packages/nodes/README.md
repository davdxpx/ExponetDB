# @exponetdb/nodes

The node agent's control plane (Wave 5, [`exponetdb-docs/07-node-agent`](../../exponetdb-docs/07-node-agent/architecture.md)).

## Certificates (`src/x509`)

A minimal DER encoder and the fixed certificate profiles of
[`enrollment.md` §1, §2](../../exponetdb-docs/07-node-agent/enrollment.md) and
[ADR-0024 §2](../../exponetdb-docs/01-architecture/adr/0024-node-trust-model.md):

| Profile | Key | Constraints | Extended key usage |
|---|---|---|---|
| `root` | Ed25519 | CA, self-signed | none |
| `server_ca` | Ed25519 | CA, path length 0 | `serverAuth` only |
| `issuing_ca` | Ed25519 | CA, path length 0 | `clientAuth` only |
| `gateway` | Ed25519 | end entity, DNS or IP names, at most 90 days | `serverAuth` |
| `node` | Ed25519 | end entity, `CN=nod_…` and exactly `urn:exponet:exponetdb:node:<ins>:<nod>`, at most 72 hours | `clientAuth` |
| `postgres_root` | P-256 | CA, self-signed (OD-17, held by the worker) | none |
| `postgres_server` | P-256 | end entity, DNS or IP names, at most 90 days | `serverAuth` |

The issuer decides every name and extension; the host contributes only a
public key whose possession it proved. The encoder only encodes: the
Control Plane parses no ASN.1.

Tests: Node's X.509 parser, `openssl verify` (including the EKU separation:
a node certificate from the server CA and a gateway certificate from the
issuing CA are refused) and, across languages, the agent's Go
`crypto/x509` and a TLS 1.3 handshake over the deterministic fixture
`tooling/fixtures/node-pki` (rewritten with
`bun packages/nodes/test/write-pki-fixture.ts`; test keys from fixed seeds).

## Services (`src/`)

[`control-plane.md`](../../exponetdb-docs/07-node-agent/control-plane.md) is
the design; each process uses only what its Control Store login allows.

| Module | Process | What |
|---|---|---|
| `pki.ts` | worker (`exponetdb node-pki init`), gateway | the ceremony (root key returned once for the owner, CA keys as gateway-consumer secrets, the first job key as a worker-consumer secret); the gateway's loader and its in-memory 72-hour TLS identity from the server CA |
| `tokens.ts` | worker, serve | token record without a secret (worker, from `node.enroll`); the one-time reveal by the applying identity (serve), the only moment the secret exists |
| `gateway.ts` | gateway | the agent API: proofs before the token, I-6, node certificates, the job state machine through the nodes schema's functions; never signs a job or judges a result |
| `binding.ts` | worker | the bind proof check that makes a node active |
| `jobs.ts` | worker | envelopes built, sealed (`ns1`) and signed; completions judged by `nr1`; what a judged completion proves (`jobEvidence`) |

Integration tests (`test/*.int.test.ts`, real PostgreSQL through
`@exponetdb/control-store/testing`) run the whole path with the proofs a
real agent computes: ceremony, token, reveal, enrollment, binding, a sealed
and signed job through the gateway, the worker's verdict, renewal and
revocation.
