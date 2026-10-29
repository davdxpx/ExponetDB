# Authorization matrix run, existence oracle, step-up, approvals and replay (Block D, tester S4)

Tree `d51da5d0`, disposable stack on vc-3, real `serve`, `worker`, `gateway`, node agent. No P0. The harness is D1's
`D/authz/run-matrix.ts`, run unchanged except one fix (below), against `http://127.0.0.1:58480`.

## Credentials on the stack (one per class of `lib-oracle.ts`)

| Class | Real credential |
|---|---|
| owner | CLI sign-in of the first owner (loopback PKCE, 30 scopes), bearer |
| admin | invited person, passkey enrolled, role `admin` global, CLI sign-in (29 scopes), bearer |
| developer-nonprod | invited person, role `developer` bound to an **environment** (staging, later also the new nonprod one), CLI sign-in (11 scopes) |
| developer-prod | the same, bound to the production environment (later the new prod one) |
| viewer | role `viewer` global, CLI sign-in (6 scopes, tiers nonprod and prod) |
| service-account | service account (responsible person: the owner) with role `developer` on the staging environment, API key (19 scopes, both tiers) |
| oauth-narrow | the owner's identity, CLI client, scope `targets.read`, tier nonprod, **one** target |
| mcp-client | DCR client, authorization code with PKCE, MCP-grantable scopes, token for `/mcp` only |

One fix to the harness: `row.rest` is absent for MCP-only actions, so `for (const r of row.rest)` throws on the first such row
(`scripts/run-matrix-s4.ts` carries the one-line change). Access tokens live 10 minutes, so the mutation pass ran one class at
a time with a token refresh before each.

## Result of the run

| Pass | Calls | ok | unobservable | bad sample | candidates | Verdict |
|---|---:|---:|---:|---:|---:|---|
| reads and every refused mutation, 7 classes, both tiers | 1,606 | 1,457 | 63 | 14 | 16 | no bypass |
| the same plus allowed mutations (`--allow-mutations`, throwaway key and client as fixtures) | 1,771 | 1,553 | 63 | 85 | 6 | no bypass |

How the numbers were made: the harness counts a generic `404 NOT_FOUND` or `422` as "allowed". `scripts/refine.py` re-reads the
results: a 404 where the owner got 2xx for the same request is a **concealed deny**; a 422 is a sample the validator refused (the
decision is not observable); a 200 on a visibility-filtered list is checked by hand. After that no row showed a deny expected and
an allow observed. The residue, all traced:

- `getInstallation` for `oauth-narrow`: allowed, and authorization.md says so (a restricted grant may read the installation
  itself); the oracle is wrong, not the engine.
- `listProducts`, `listProjects`, `listTargets`, `getFleet`, `getFindingSummary`, `listFindings`, `listSavedQueries`,
  `getBackupOverview` for environment-bound developers and the service account: visibility-filtered lists (one target, the
  product that contains the bound environment). No production object appeared for `developer-nonprod` or the service account.
- `approveOperation`, `rejectOperation`, `revealEnrollmentToken`, `getBundle`, `getBundleFile`, `ingestBundles`, backup repository
  plans: the fixtures had no real object of that kind, so every class got the same 404; these were then driven by hand (sections
  below) or are NOT RUN (stored bundles, enrollment token).
- `cancelSessionQuery`, `planSessionTermination` for owner and admin: 503 `TARGET_CREDENTIAL_INVALID`. The lab has no
  `exponetdb_operator` credential, so signalling is impossible by design and the engine answers with that code (it says "needs
  rotation or repair", which is misleading; F-S4 finding 6). The authorization decision itself is not observable there.
- viewer "over-restrictive" (43 rows) in the first pass: my consent had given the viewer's grant the nonprod tier only; with both
  tiers the viewer rows agree with the oracle.

Not run: the 17 routes without a valid-shaped sample after the 10 bodies added, MCP rows other than the tool calls of the agent
section, Web-session-only actions (every bearer is refused for them: rows `D`, all agree), CLI commands (see finding 3).

## Existence oracle (404 for a fabricated id against the answer for a real object the credential may not see)

Run with `ids` empty and `foreign` set to real objects. For callers that cannot see the object, a real id answers
**403** (`PERMISSION_DENIED`, `TIER_NOT_PERMITTED`, `INSUFFICIENT_SCOPE`) and a fabricated id **404**:

| Route family | Differing credentials |
|---|---|
| `GET /clusters/{id}`, `/backup-policy`, `/backups`, `/backup-repositories`, `/backup-runs`, `/findings`, `/drills`, `/restores` | developer-nonprod, developer-prod, service-account |
| `GET /servers/{id}` | the same |
| `GET /nodes/{id}`, `/jobs`, `/observations`; `POST /nodes/{id}/inspections`, `/config-updates`, `/revoke`, `/decommission` | the same, viewer (plans), oauth-narrow |
| `GET /products/{id}`, `/projects/{id}`, `/products/{id}/environments` | oauth-narrow |
| `POST /backup-repositories/{id}/ownership`, `/retire` | developer-nonprod, developer-prod, service-account, viewer, oauth-narrow |
| `POST /plans/{id}/withdraw`; `POST /operations/{id}/cancel`, `/retry-verification`, `/approve`, `/reject` | all lesser classes (apply, approve and reject are the documented residual, error-model.md:365) |

Targets, saved queries, audit by target and plan/operation reads were uniform (404 for both). D1 had marked clusters, servers and
products as uniform and the node, backup repository and registry-plan families as the leak; the run shows the leak is wider
(finding 5). Ids are 26 random characters, so this confirms an id, it does not enumerate.

## Body size before authorization (D1's first P2), over HTTP

`scripts/bigbody.py`: a viewer bearer (no `migrations.plan`) posts a valid-shaped body to `POST /targets/{id}/migrations/plans`.

| Body | Credential | Answer | Latency | serve RSS before / peak / after | serve CPU |
|---|---|---|---:|---|---:|
| 4.3 MiB | viewer | 403 `PERMISSION_DENIED` | 0.08 s | 343 / 362 / 344 MiB | 0.26 s |
| 28.5 MiB | viewer | 403 | 0.27 s | 344 / 475 / 450 MiB | 0.73 s |
| 28.5 MiB | viewer | 403 | 0.22 s | 450 / 556 / 368 MiB | 0.57 s |
| 28.5 MiB | service account | 422 `MIGRATION_MANIFEST_INVALID` | 0.24 s | 368 / 528 / 528 MiB | 0.54 s |
| 28.5 MiB | none | connection closed by the server before the body was read | n/a | n/a | n/a |
| 8 x 28.5 MiB at once | viewer | (per-request status not captured; the server stayed ready) | n/a | 344 / **838** MiB peak | n/a |

Confirmed: an authenticated caller who holds nothing makes the process read, parse and validate up to 32 MiB (about +130 to +210
MiB RSS each). An unauthenticated caller is refused before the body is read, so the cost is reachable by any signed-in identity,
including a viewer. The box did not run out of memory at 8 in parallel (4.9 GB available at the low point); 30 or more would.

## Step-up bypass (ADR-0026), on production plans that need an approval and a re-authentication within 300 s

`scripts/stepup.sh`; the actor is the owner's CLI client. The receipt travels in the header `Exponetdb-Step-Up`.

| Case | Answer |
|---|---|
| apply with no receipt | 401 `REAUTH_REQUIRED` |
| receipt requested but not yet confirmed | 401 `REAUTH_REQUIRED` |
| another person confirms my step-up | 404 `NOT_FOUND` |
| confirm with a wrong user code | 422 `VALIDATION_FAILED` |
| confirmed receipt bound to plan F2 used on plan F1 (foreign action) | 401 `REAUTH_REQUIRED` |
| the owner's confirmed receipt presented by a service account / by the admin | 401 `REAUTH_REQUIRED` |
| service account / MCP client requests a step-up | 403 / 401 |
| receipt confirmed, then 130 s wait (lives 120 s), then apply | 401 `REAUTH_REQUIRED` |
| step-up id sent on a cookie session request | 422 (a bearer request only) |
| own confirmed receipt on its own plan | 202 `awaiting_approval` (one operation) |
| replay: the redeemed receipt on another plan / on the same plan again | 401 `REAUTH_REQUIRED` |

No bypass. The applying client is also bound: a plan made by the CLI cannot be applied by the same person's web session, nor by
an MCP client or another person (`PLAN_BINDING_ACTOR`).

## Approval spoofing, self-approval and replay (production operation awaiting approval)

`scripts/approvals4.sh`; the operation was applied by the owner's CLI client, approver candidates below.

| Attempt | Answer |
|---|---|
| service-account API key | 403 `PERMISSION_DENIED` |
| MCP client token | 401 `UNAUTHENTICATED` (a different audience) |
| the applying identity's own CLI bearer, acknowledged / the admin's CLI bearer | 403 / 403 (approval is a Web App act) |
| viewer, developer-nonprod, developer-prod (web, fresh proof) | 403 (no `plans.approve`) |
| applying identity in the web session, no acknowledgement | 422 `SELF_APPROVAL_UNACKNOWLEDGED` |
| applying identity, acknowledged, proof 310 s old | 401 `REAUTH_REQUIRED` |
| admin, fresh proof, wrong plan hash / body without hash | 409 `PLAN_STALE` / 422 |
| admin (a different person), fresh proof, right hash | 200; the operation ran and verified |
| approve the same operation again | 409 `APPROVAL_NOT_PENDING` |
| apply the consumed plan again (other person / other client) | 409 `PLAN_ALREADY_USED` / `PLAN_BINDING_ACTOR` |
| apply the consumed plan again, same actor, no receipt | 202 with the **existing** operation (no new operation, ledger unchanged) |
| withdraw the consumed plan | 409 `PLAN_ALREADY_USED` |

Not exercised: the permitted self-approval (acknowledged, fresh proof, OD-9), enrollment-token reuse and the `critical` cooling
period; see decisions. Worth knowing, by design: a developer with a production binding and `migrations.apply:prod` applied a
standard, evidence-verified production migration through the CLI with **no approval and no fresh proof** (`202`, the table
exists on the target) because no policy rule fired; approvals and fresh proofs come from rules (lineage divergence, non-transactional,
rollback, node changes, agent origin).

## What the CLI could not do

Every remote CLI command fails with `PERMISSION_DENIED` for the two environment-scoped developers (table and `--json`): the first
call of each command is `GET /installation` (`apps/cli/src/cli/remote.ts:198`), which the oracle marks `D` for an environment
binding. The same people read their targets over REST. That is finding 3. For the viewer and the owner the commands work.
