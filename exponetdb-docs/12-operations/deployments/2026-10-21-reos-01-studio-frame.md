# Rollout on reos-01: the Studio-like Web App (2026-10-21)

| | |
|---|---|
| Status | **[OBSERVED]** Running on `825b17f` (merge of `davdxpx/ExponetDB#31`); deployed at the owner's request **before G8 is accepted**; off-host audit export and automated off-host backups remain **NOT PROVEN** (open since the [first rollout](./2026-10-06-reos-01.md)) |
| Measured | 2026-10-21, 13:26 to 13:29 UTC |
| Source release | `825b17f04cdac58575c6a0710552a1a30a34bac1` (`main`, merge of `davdxpx/ExponetDB#31`) |
| Previous release | `1484bb5` ([Wave 8 completion record](./2026-10-20-reos-01-wave8.md)), image tag `sha256-5ce8b418aa09aa89d5a601fd774c2bdf3366787b8d576528f16a79f780e1c2e2` |
| Scope | ExponetDB resources only (project `ExponetDB`); no REOSA, Supabase or managed target changes |
| Gate | This record changes no gate. G8 awaits the owner ([G8 record](../../14-roadmap/gates/8.md)); deployment evidence for [G2](../../14-roadmap/gates/2.md) is still outstanding |

This record supersedes the "Source release" and image lines of the
[Wave 8 completion record](./2026-10-20-reos-01-wave8.md); the resource list,
network, backups and open work of the earlier records stand.

## Release

**[OBSERVED]** `davdxpx/ExponetDB#31` carries the owner's UI review of
2026-10-21: the frame built like Supabase Studio's (a rail per level, the path
in the header, a fixed frame, the account column), the plan review and
operation pages rebuilt, the account pages and list toolbars, the server
providers with their logos, and Go 1.26.10 for the node agent. The merge
commit's tree is the PR's last head `7b4ccc6`. On that content the Web App's
unit suite (159 files, 2371 tests), `ui-data` (41 files, 775 tests) and the
browser suite (52 tests) passed locally, and CI's browser job passed on the
same content once the CI baselines of the plan summary were adopted. `main`'s
CI run on `825b17f` (run `39607575295`) was **still running** when the rollout
started, at the owner's request; its result is not part of this record.

The owner built the release on `reos-01` from a clean `git archive` export of
`825b17f` (no working-tree files, no `.git`) with
`docker build --build-arg EXPONETDB_BUILD_COMMIT=825b17f04cdac58575c6a0710552a1a30a34bac1`,
tagged it with its own ID and pushed it to the loopback registry:

| Check | Result |
|---|---|
| Registry tag | `127.0.0.1:5000/exponetdb:sha256-f4870ac5736b73c60a038ea35215e5cbad70b9bfcfecfb9c2de980c1858babb8` |
| Set on | `exponetdb-worker`, `exponetdb-gateway`, `exponetdb-serve` and the image line of `exponetdb-migrate`, read back through the Coolify tools; descriptions name `825b17f` |
| Build commit reported by each role | `825b17f04cdac58575c6a0710552a1a30a34bac1`, version `0.2.0` |

The release adds one Control Store bundle,
`01M5F4NHFTMQRYJA43P8GKP44M_server-providers` (it widens the CHECK of
`servers.provider` to the longer provider list; no frozen bundle changed), so
a backup was taken before the migration.

## Order and timing (UTC)

| Time | Step | Observed result |
|---|---|---|
| 13:26:23 | Backup before the migration: schedule `jw8pwd8gqufcl72y0iw7ewlx` of `exponetdb-control`, run by the owner, execution `1sq5fpmpjilksujew58enprr` | success, 144,948 bytes (complete `pg_dumpall`, local only) |
| 13:26:56 | Readiness before the rollout | `/healthz/ready` and `/healthz/live` `200` (the `1484bb5` release) |
| 13:27:13 | `exponetdb-migrate` started | `exited`; the old `serve` answered `503` (`not_ready`) from 13:27:17, as a release older than the ledger does |
| 13:27:28 | `worker` deployed (deployment `j0a00dez768bux3ls3qhhncv`) | `buildCommit 825b17f…`, state `ready` at 13:27:35 |
| 13:27:32 | `gateway` deployed (deployment `87lvc5aui2f6tkau8uknmwx3`) | `buildCommit 825b17f…`, agent listener open on 7443, `not_ready` at start as before |
| 13:27:33 | `serve` deployed (deployment `ox5eujbhfx1299zptxagwf9i`) | `buildCommit 825b17f…`, state `ready` at 13:27:40 |

The Web App was unavailable for about 29 seconds: polled every 2 to 3 s,
`/healthz/ready` answered `503` from 13:27:17 to 13:27:44 (once `502` at
13:27:37, while the `serve` container was swapped) and `200` from 13:27:46 on.

**Not observed directly:** the exit status and log of the migration container
(the Coolify tools read logs of running containers only). The evidence that
the bundle was applied is the old `serve` refusing readiness once the
migration ran, and the new roles reporting ready, which they do only on a
ledger that is `current` for their build.

## Result

| Check | Result |
|---|---|
| `https://db.exponet.cloud/healthz/ready` | `200`, `{"status":"ready"}` |
| Login page | `200`, with a `Content-Security-Policy` header |
| Anonymous `GET /api/v1/targets`, `GET /api/v1/installation` | `401` |
| `HEAD /mcp` | `405` with `Allow: POST` |
| Anonymous `POST /mcp` (`initialize`) | `401` with `WWW-Authenticate: Bearer resource_metadata="https://db.exponet.cloud/.well-known/oauth-protected-resource/mcp"` and the MCP-grantable scopes |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` | `200` |
| The Web App served | its message catalog chunk holds the new texts ("Back to the fleet", "Before it can run", "Hetzner Dedicated (Robot)") |
| Coolify | `worker`, `gateway` and `serve` deployed and running; `migrate` `exited` |
| MCP after the switch | a signed-in client's `server/discover` answered `200` at 13:27:51 (`serve` log; no session of this record) |

## Not verified here

- The new screens were not exercised on the installation with a signed-in
  person: no session, grant or token was used, so every check above is
  anonymous. The screens were checked in Chromium by the browser tour before
  the merge.
- `main`'s CI result on `825b17f` (see Release).
- `audit verify`, `keyring status` and `control-store status` through the
  operator commands; the readiness probes are the evidence.
- Node agents (none checked or updated; the Go 1.26.10 node agent is not
  released to any host), off-host audit export and off-host backups:
  unchanged, **open**.

## Rollback anchor

The schema changed (one additive bundle), so the previous release does not
run on this ledger: its roles refuse readiness with a newer ledger. A return
to `1484bb5` needs the backup above (execution `1sq5fpmpjilksujew58enprr`)
restored into `exponetdb-control` first, then the tag
`sha256-5ce8b418aa09aa89d5a601fd774c2bdf3366787b8d576528f16a79f780e1c2e2` on
the three roles and the `exponetdb-migrate` image line
([`upgrades.md` §1](../upgrades.md)). A fix forward is the usual way.

## Access used

**[OBSERVED]** The Coolify MCP tools of the session read the state and the
backup executions, started the migration service, deployed the three roles
and read their logs; they cannot change an image tag or run a backup. The
owner ran the backup, built and pushed the image on `reos-01` and set the
tags, descriptions and the Compose image line in the Coolify web interface.
No token, address of a person or credential is part of this record.
