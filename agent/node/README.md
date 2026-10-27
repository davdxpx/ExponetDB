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

## Wave 9 Part B (backups and restores)

The root helper answers the eleven backup and restore capabilities
(ADR-0036 to ADR-0038; `internal/helper/ops_backup.go`): catalog reads
(`backup.list@1`, `backup.timers@1`, `restore.prepare@1`, `run.status@1`)
and the starts of supervised engine runs (`backup.run@1`, `backup.verify@1`,
`backup.expire@1`, `restore.execute@1`, `restore.verify@1`), their cancel
(`run.cancel@1`) and the scratch discard (`restore.discard@1`). A run is a
transient systemd unit (`exponetdb-run-<runId>.service`, fixed properties,
`systemd-run` with a fixed template) that executes
`exponetdb-node-helper engine-run --run <runId>` as the data directory's
owner; the run record lives under `/var/lib/exponetdb-node-engine/runs`
(root, `tmpfiles.d`), scratch restores under `.../scratch`.

Host files per repository, under `/etc/exponetdb-node/repositories/<repositoryId>/`
(the directory and every file root-owned, writable by root only):

| File | Content | Needed |
|---|---|---|
| `mode` | `adopted_observed`, `adopted_runs` or `owned` (absent: `adopted_observed`) | to allow runs (`adopted_runs`: incremental backups; `owned`: every kind and expiry) |
| `pgbackrest` | exactly the lines `stanza=<name>` and `repo=<1..4>` (`#` comments allowed) | for a pgBackRest repository whose mode allows runs; when present, a job naming another stanza or repo index is refused, reads included |
| `repository`, `password` (`0600`), `env` (`0600`, optional) | a restic repository, its password, allowlisted `AWS_*`, `B2_*` and `RESTIC_COMPRESSION`/`RESTIC_PACK_SIZE` variables | restic and pg_dump repositories |

pgBackRest reads the host's own configuration (`pgbackrestConfig` in the operator
configuration, else `/etc/pgbackrest/pgbackrest.conf`, else
`/etc/pgbackrest.conf`); when a `conf.d` directory lies beside it, the helper
merges it and every engine command names it (`--config-include-path`). Every
pgBackRest run checks that the stanza's `db-system-id` is the job's cluster
before it starts and again before the engine runs.

- Unit tests: `go test ./internal/helper/` (scripted systemd and engines).
- Lab test with the real engines (root; pgBackRest, restic and PostgreSQL 17
  installed): `go test -tags pglab -count=1 -run TestPglab -v ./internal/helper/`.
  It runs each engine run as a direct child instead of a transient unit:
  the systemd side is **not proven** by it.

