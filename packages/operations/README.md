# @exponetdb/operations

The Operations Engine skeleton
([operations-engine.md](../../exponetdb-docs/02-control-plane/operations-engine.md),
§11 for what Wave 2 builds): the single path of every consequential
mutation. Plan binding, staleness, idempotency, leases, exclusivity,
reconciliation and audit are implemented once; operation kinds supply only
their domain work. Wave 2 registers no product kinds.

## Owns

| Module | What |
|---|---|
| `states.ts` | the state machine and the outcomes each state admits (mirrored by the database guard) |
| `plans.ts` | plan creation (canonical body, plan hash, lifetimes per class), reading with content check, withdrawal, expiry job |
| `accept.ts` | `acceptPlan`: row lock, binding order, idempotent acceptance, invalidation, requirements |
| `transitions.ts` | `transitionOperation`, the single transition API (event, lock release, audit in the caller's transaction) |
| `leases.ts` | claim (`SKIP LOCKED`), renew, give back; takeover moves `running` to `needs_reconciliation` |
| `locks.ts` | exclusivity domains: grammar, expansion, global order, all-or-nothing acquisition |
| `idempotency.ts` | `Idempotency-Key`: begin, complete, replay, reuse refusal, pruning |
| `kinds.ts`, `driver.ts` | the `OperationKind` interface, the registry, the worker loop for one operation |
| `settings.ts` | reads `policy.rule_settings` for the policy engine |

## Does not own

Operation kinds (later waves), approvals and break-glass grants (Wave 3A and
later), node jobs (Wave 5), authorization (runs before planning), interfaces.

## Allowed dependencies

`@exponetdb/contracts`, `@exponetdb/control-store`, `@exponetdb/policy`,
`@exponetdb/audit`, `@exponetdb/kernel`. Never `secrets`, observability
interfaces or apps.

## Security properties

- A transition the state machine forbids fails in the code and in the
  database (`EXO01`); serve cannot touch an operation once execution begins
  (`EXO02`); a plan body that does not hash to the plan hash is refused
  (`EXO03`).
- Every transition and its audit event commit together, or neither does.
- A lost worker never resumes blindly; `execute` runs at most once per
  operation; outcomes are reported, never inferred.
- No force flag and no force-release: a live operation's locks cannot be
  deleted.

## Tests

`bun run test`: state machine tables and property tests, domain ordering,
idempotency key grammar and request hashes. `bun run test:integration`
against PostgreSQL 17: code and database agree on every transition and
outcome; guard refusals; concurrent acceptance; invalidation; requirements;
atomic audit with failure injection; two-worker leases and takeover;
lock conflicts, no force-release, deadlock freedom under random concurrent
sets; idempotency replay, reuse, concurrency, rollback, expiry, pruning;
every worker loop path with synthetic kinds; the audit chain verifies.
