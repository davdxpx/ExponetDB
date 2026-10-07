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
