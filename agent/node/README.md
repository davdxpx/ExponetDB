# agent/node

Go module of the ExponetDB Node Agent (`github.com/davdxpx/ExponetDB/agent/node`).
The module path uses the repository's canonical casing (`davdxpx/ExponetDB`);
Go module paths are case-sensitive, and the module proxy encodes the capitals.

## Wave 1 scope

The agent itself (daemon, root helper, capabilities) is built in Wave 5. In
Wave 1 this module holds only:

- `internal/canon`: strict JSON parsing (RFC 8259 plus the I-JSON constraints
  of RFC 7493) and RFC 8785 canonical JSON (JCS). Production code: the agent's
  job-signature verification uses it in Wave 5.
- `internal/conformance`: the independent second implementation of the frozen
  hash contracts: ids, `c1` executable text, manifest projections, the apply
  checksum and the verify, rollback, bundle and source digests, the `ls1`
  ledger state hash and the plan hash. It exists for tests and is never linked
  into the agent binaries.
- `internal/protocol`: the node protocol types, generated from
  `packages/contracts/generated/jsonschema/node-protocol.v1.json` by
  `bun run generate` (`types_gen.go`, never edited by hand). Its tests decode
  every fixture in `tooling/fixtures/node-protocol` strictly (unknown fields
  are refused) and round-trip it.

## Wave 5 (in progress)

Production packages of the agent (`exponetdb-node`), standard library only:

- `internal/nodecrypto`: the node protocol constructions of `protocol.md`
  §7 (job signature, enrollment token and proofs, `nr1`, HPKE `ns1`),
  written from the specification.
- `internal/config`: the root-owned operator configuration (strict JSON,
  never written remotely).
- `internal/state`, `internal/fsutil`: the agent-owned state and identity,
  written atomically with checksums.
- `internal/journal`: the hash-chained job journal and nonce cache.
- `internal/clock`: the trusted-clock rule.
- `internal/schema`: validation of arguments and results against the
  embedded generated schema (`internal/protocol/schema_gen.json`).

## Independence

`internal/canon` and `internal/conformance` implement the specification
directly, never from the TypeScript code in `packages/`:

- [`migration-bundles.md` §2, §3 (N1 to N7)](../../exponetdb-docs/04-migrations/migration-bundles.md#normative-definition-of-c1-frozen-at-g1)
- [`ledger.md` §3](../../exponetdb-docs/04-migrations/ledger.md#3-derived-values)
- [`operations-engine.md` §3.1](../../exponetdb-docs/02-control-plane/operations-engine.md#31-content)
- [`domain-model.md` §2](../../exponetdb-docs/01-architecture/domain-model.md#2-identifiers)
- RFC 8785

The tests load every vector in [`tooling/golden`](../../tooling/golden/README.md)
and must pass, exactly like the TypeScript production code. Each vector is a
subtest named by its id; none is skipped.

## Tests

```sh
cd agent/node && gofmt -l . && go vet ./... && go test -race -count=1 ./...
```

Standard library only; no module downloads.
