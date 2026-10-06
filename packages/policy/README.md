# @exponetdb/policy

The Policy Engine framework
([policy-engine.md](../../exponetdb-docs/02-control-plane/policy-engine.md)):
given who is asking, through which client, for what and under which facts, is
a change allowed, and under which conditions? Pure: no I/O of its own, no
Control Store access; callers pass facts providers and configuration rows.

## Owns

| Module | What |
|---|---|
| `model.ts` | request, principal, subject scope, break-glass, rule result, decision |
| `rules.ts` | the `Rule` interface and the `RuleRegistry` (definitions checked at startup, rules per kind in id order) |
| `facts.ts` | fact provider interface, fact names, the `principal` provider |
| `config.ts` | resolution of scoped settings (installation → product → project → environment → target, per parameter, typed like the defaults) |
| `engine.ts` | `PolicyEngine.evaluate`: deterministic evaluation, fail-closed `unknown`, deny > require > allow, warnings never block, break-glass per named rule for humans only |
| `recheck.ts` | `recheckDecision` at apply: stricter or new requirements are stale |
| `version.ts` | the policy version `pv1` (golden vectors `tooling/golden/policy-version.json`) |
| `catalog/access.ts` | Wave 3A rules: `access.no-self-escalation`, `access.owner-only`, `access.last-owner`, `access.policy-safety`, `access.erase-approval`, `approval.self-approval` (OD-9), and the safety-direction comparator for policy changes |

## Does not own

Catalog rules of other domains (each wave adds the rules of the kinds it
implements), fact providers (the `access` fact is computed by `packages/auth`) (evidence, ledger, backups, target), the
storage of settings (`policy.rule_settings`, read by `operations`),
authorization (RBAC and scopes run before policy).

## Allowed dependencies

`@exponetdb/contracts`, `@exponetdb/kernel`. Never `control-store`,
`operations`, `audit` or interfaces.

## Security properties

- Unknown fails closed at the rule's severity; a requirement cannot be lost
  through an error; there is no force flag.
- Agent reasoning never reaches a decision: rules see the request, typed
  facts and configuration only; MCP clients can never override.
- Decisions are reproducible: the policy version binds build, rule versions
  and effective configuration.

## Tests

`bun run test`: pv1 golden vectors, table tests for combination, unknown,
break-glass and configuration, registry refusals, and property tests (order
independence, monotonicity, unknown never more permissive than fail, warn
never blocks, break-glass isolation, re-check staleness).
