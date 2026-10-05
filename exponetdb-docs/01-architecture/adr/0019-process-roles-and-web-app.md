# ADR-0019: One image, three process roles, SPA Web App

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-20, C-23; [`../overview.md`](../overview.md), [`../../12-operations/deployment.md`](../../12-operations/deployment.md) |

## Context

The internet-facing API, the worker that holds database credentials and signs
jobs, and the gateway that holds the agent issuing CA have very different risk
profiles. Separate codebases would duplicate domain logic.

## Decision

One server application and one container image with three **process roles**:

- `serve`: Web App assets, `/api/v1`, `/mcp`, OAuth endpoints; decrypts only the
  read-only **observer** credential (planning, fast staleness checks); never the
  reader, operator or migrator credentials;
- `worker`: operations, samplers, reconciliation, `data.read` execution on behalf
  of `serve`; decrypts all target credentials, signs node jobs;
- `gateway`: agent mTLS endpoint on the private network; holds the issuing CA.

Each role runs as its own Coolify resource with its own environment secrets and
its own Control Store login role. The Web App is a React single-page application
served by `serve`, talking only to `/api/v1` and `/oauth` like any other client;
it has no server-side data access of its own.

## Alternatives considered

- **Single process with all secrets.** Rejected: one remote-code-execution bug in
  the API would expose data-reading and writing database credentials and signing
  keys. The observer credential in `serve` is the accepted exception: it reads
  statistics and catalogs, not table data, and keeps planning synchronous.
- **Microservices with separate codebases.** Rejected: duplicated domain logic.
- **Server-rendered framework with its own data access (for example Next.js server
  components).** Rejected: a second path to the database outside the application
  layer would undermine C-9.

## Consequences

- Three deployable resources from one release.
- The Web App needs no special trust; it is tested through the same API.
