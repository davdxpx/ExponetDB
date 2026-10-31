# I12 / I13 promotion and immutability (Block D, tester S4, partial)

Tree `d51da5d0`. Evidence environment `s4evi` (nonprod), production `s4prd` (prod, `evidenceFrom: s4evi`), both fresh PG17
databases on the adopted cluster. Plans only; the cases that apply say so.

## Run

| Case | Result |
|---|---|
| Bundle never applied on the evidence target, planned for production | decision `deny`; rules `migration.staging-evidence` (deny) and `migration.fingerprint-lineage`; evidence `missing` |
| Bundle applied and verified on another nonprod environment (dev16), not the evidence source | the same: `deny`, evidence `missing` (a different nonprod environment is not evidence) |
| Bundle applied and verified on the evidence target, planned for production | decision `allow`/`require` as the lineage rule decides; evidence `present` with the evidence target id, verification id and time |
| Evidence present but production and the evidence target diverged before this migration | `migration.fingerprint-lineage` fails with `require` (an approval); with lint errors on top, `deny` |
| The same migration id with other bytes after it was applied on the evidence target, planned from the CLI | `MIGRATION_CHECKSUM_MISMATCH` ("applied history is immutable"), both for production and for the evidence target |
| Self-approval on production by the planner (CLI, SA, MCP) | refused on every path (authz-run.md, approval table); the permitted web self-approval with acknowledgement was not exercised |
| Agent path (MCP) on production | waits for a person (agent-safety-dynamic.md) |

A standard, evidence-verified production migration by a developer with a production binding runs with no approval and no fresh
proof when no rule fires (authz-run.md). That is the rule set working as written, not a bypass.

## NOT RUN

- An environment alias or label swap (change `evidenceFrom` of the production environment, then plan): plans that edit
  environments need the registry flows and were not started.
- A verified-then-restored evidence target, and an evidence run that was `applied` but not `verified` (needs a verify that fails
  after a successful apply; `B/failure` has the machinery).
- The forged-evidence case of `F/findings-B1.md` (a hand-written ledger row plus a passed verification row on the evidence
  target, then a production plan): this is the one to run first next; it needs direct writes to a target ledger and a Control
  Store row, which this session did not start.
- Immutability across REST, MCP import and concurrent uploads of the stored-bundle store (only the CLI plan path was driven).
- An old plan after a policy change.
