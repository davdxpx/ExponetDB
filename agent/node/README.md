# agent/node

Go module of the ExponetDB Node Agent (`github.com/davdxpx/exponetdb/agent/node`).

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
cd agent/node && gofmt -l . && go vet ./... && go test -count=1 ./...
```

Standard library only; no module downloads.
