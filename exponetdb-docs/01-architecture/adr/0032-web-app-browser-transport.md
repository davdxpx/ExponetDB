# ADR-0032: The Web App's browser transport: a cookie client over the SDK's operations table

| | |
|---|---|
| Status | Proposed (Wave 8 Phase 1; in force for the wave, confirmed or changed by the owner at G8) |
| Date | 2026-10-13 |
| Related | [ADR-0019](./0019-process-roles-and-web-app.md), [ADR-0026](./0026-cli-step-up-browser-handoff.md), [ADR-0031](./0031-web-app-serving.md); [`../../13-integrations/sdk.md`](../../13-integrations/sdk.md), [`../../08-auth-and-security/identity.md` §8](../../08-auth-and-security/identity.md#8-browser-ceremonies-wave-3a), [`../../08-auth-and-security/threat-model.md`](../../08-auth-and-security/threat-model.md) (T23, Wave 8); the [Wave 8 order](../../14-roadmap/orders/wave-8-order.md) D10 and §7 |

## Context

The rebuilt Web App needs typed access to `/api/v1` and the `/auth`
ceremonies. `@exponetdb/sdk` is typed by the contracts but authenticates
with an `Authorization` header (service accounts, API keys), imports
`node:crypto` and `jose`, and is documented as Node-only. The browser must
authenticate with the `__Host-exdb_session` cookie and the
`__Host-exdb_csrf` token instead: a cookie plus a bearer is
`AMBIGUOUS_CREDENTIALS`, and a cookie-authenticated mutation needs the exact
`Origin`, `Sec-Fetch-Site: same-origin` and `x-csrf-token` equal to the
CSRF cookie. The server rotates the session secret and the CSRF token at
every re-authentication; a query-cache SPA with parallel requests in flight
around a step-up would see `SESSION_EXPIRED` and bounce to the sign-in page.

## Decision

1. **Types from the SDK's browser subpath.** `@exponetdb/sdk/operations`
   exports only the generated `OPERATIONS` table and the generated wire
   types (no transport, no `node:` module, no `jose`). The Web App takes its
   paths, methods and request and response types from it, and contract types
   from `@exponetdb/contracts` with `import type` only (`graph.json` rules
   `web-sdk-operations-only`, `web-contracts-types-only`).
2. **One client.** `apps/web/src/lib/api/client.ts`: same-origin `fetch`,
   `credentials: 'same-origin'`, `cache: 'no-store'`, JSON in and out, path
   parameters percent-encoded as one segment, never an `Authorization`
   header. The CSRF token is read from its cookie for **every** request and
   never cached or stored. A problem becomes an `ApiError` carrying only the
   stable code and the server's catalog message; a body that is not a
   catalog problem shows a fixed text. Components never call `fetch`.
3. **The request gate.** A re-authentication closes the gate (new requests
   wait), waits for the requests in flight to settle (at most 15 s), runs
   the ceremony once for all callers, and opens the gate; the waiting
   requests then read the rotated token. The action that needed the proof
   runs **once** more; a canceled confirmation is "Canceled. Nothing was
   changed." (`withReauth`).
4. **Rotation race.** A request that answers `SESSION_EXPIRED` while its
   CSRF cookie changed under it was refused before anything ran; it is sent
   once more. Any other `SESSION_EXPIRED` ends the session in the page: the
   query cache is dropped and the page leaves for the sign-in page with a
   safe return target.
5. **The query cache** (TanStack Query) lives in memory only; reads are
   retried only when the server could not be reached or was unavailable;
   mutations are never retried by the cache; every read reaches a component
   as a `Readable<T>` through one adapter, so a failed read can never render
   as empty (C-28).

## Alternatives considered

- **Use the SDK's transport with a cookie mode.** Rejected: the SDK would
  carry two authentication models and its browser build would still pull
  `jose`; the Web App's CSRF and re-authentication handling is specific to
  the first-party browser.
- **Generate a second, browser-only client.** Rejected: a second generator
  and a second copy of the operations table that can drift.
- **Read the CSRF token once at load.** Rejected: it rotates at every
  re-authentication.

## Consequences

- The SDK stays Node-only for its transport; `sdk.md` names the subpath.
- Tests: `apps/web/test/api/` (CSRF read per request, no `Authorization`
  header, catalog-only error text, the rotation retry and its limit, the
  gate: one ceremony for parallel actions, no bounce for a request in flight,
  a hanging request does not hold the ceremony), `packages/sdk/test/operations.test.ts`.
