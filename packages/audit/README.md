# @exponetdb/audit

Append-only, hash-chained audit
([audit.md](../../exponetdb-docs/02-control-plane/audit.md),
[ADR-0023](../../exponetdb-docs/01-architecture/adr/0023-audit-chain-hash-ac1.md)).
The tables, triggers and the database chain guard live in the Control Store
bundle `01M46KJ06G9BHM1ZR7CDD2JZ2S_audit-chain`; this package is the code
that writes, checks, anchors and prunes the chain.

## Owns

| Module | What |
|---|---|
| `chain.ts` | the chain hash `ac1` (frozen from the first stored event; golden vectors `tooling/golden/audit-chain.json`), genesis value `ac1:genesis:<installation id>` |
| `writer.ts` | `appendAuditEvent(tx, input)`: validates `exponetdb.audit/v1`, appends in the caller's transaction under the chain lock (`audit_event_invalid`, `audit_append_failed`) |
| `verify.ts` | `verifyAuditChain`: read-only recomputation from genesis, a checkpoint or a retention boundary; reports the first failing `seq` and a reason |
| `checkpoints.ts` | checkpoints of the chain head, export of pending checkpoints (oldest first, stops at the first failure, records each export), export state |
| `export/` | checkpoint documents (`exponetdb.audit-checkpoint/v1`, canonical JSON), a file sink and an S3-compatible sink (Signature Version 4 without an SDK, `If-None-Match: *`, optional object lock) |
| `pseudonym.ts` | keyed pseudonyms (`hmac-sha256:`) for IP addresses and user agents; the key is supplied by the composition root, never stored in audit rows |
| `retention.ts` | the `retention.audit` setting (default `permanent`, at least 400 days), partition upkeep, `exponetdb audit prune` (one partition and its `retention.pruned` event per transaction) |

## Does not own

Which actions are audited (each domain package appends its own events),
the pseudonym key's storage (`secrets`), scheduling (the worker), the
command-line wiring (`apps/server`).

## Allowed dependencies

`@exponetdb/contracts`, `@exponetdb/control-store`, `@exponetdb/kernel`
(foundation). Never `operations`, `policy`, `secrets` or `observability`
(errors carry codes, not log fields).

## Security properties

- No role can update, delete or truncate audit rows; triggers refuse it for
  the owner too. Runtime roles cannot disable triggers or change the schema.
- The database recomputes `ac1` for every insert and refuses a gap, a fork,
  a forged hash, mismatching query columns and time running backwards
  (`EXA02` to `EXA04`), whatever the writer does.
- Exported checkpoints detect a consistent rewrite by a superuser or the
  owner; export credentials are held in memory and never appear in errors.
- Events carry identity ids and pseudonymous labels, never names, e-mail
  addresses, raw IPs or user agents; `reason` is untrusted and capped.

## Failure behavior

An audit append failure fails the audited change (same transaction). An
export failure never blocks writes: it is reported, retried on the next run
and blocks retention. Verification is read-only and has no repair mode. An
invalid retention setting prunes nothing.

## Tests

`bun run test` (golden vectors, pseudonyms, SigV4 against the published AWS
example, sinks); `bun run test:integration` against PostgreSQL 17 and an
S3-compatible server (`EXDB_TEST_PG_URL`, `EXDB_TEST_S3_*`,
[local-development.md §5](../../exponetdb-docs/12-operations/local-development.md#5-what-exists-since-wave-2)).
