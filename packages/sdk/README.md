# @exponetdb/sdk

A typed client for `/api/v1` ([`sdk.md`](../../exponetdb-docs/13-integrations/sdk.md),
§6 for the Wave 4 slice). Version `1.0.0-alpha.1`, private, not published.

**Responsibility.** Types generated from the committed OpenAPI document
(`src/generated/api.ts`, `bun run generate`); a small transport (one
request per call, percent-encoded path parameters, exploded query arrays,
a deadline, bounded `GET` retries); Result-shaped errors that keep the
problem document's catalog fields; cursor pagination with an item bound;
server-side authentication with an `exak_` API key or a service account
(`private_key_jwt` signed by `jose`, one in-memory `/api` token).

**Not its responsibility.** Anything the server decides: authorization,
policy, plans, tiers, drift, target resolution (a path goes to the server
as one segment). No retry of a mutation, no browser build, no storage of
keys or tokens, never a database credential or connection string.

**Allowed dependencies:** `contracts` (by generated types only; the
`sdk-own-generated-only` rule lets `src/` import its own generated module
and no other generated file). Runtime library: `jose`.

**Security boundary.** Keys and tokens stay in memory; an API key only in
the `Authorization` header; the token request asks for the API resource
only, never `/mcp`; a denial is returned as a denial (no fallback to
another target, no fuzzy path); response bodies are reduced to catalog
fields, so a stray field (a stack, a password) never reaches the caller.

**Major interfaces.** `new ExponetDB({ baseUrl, auth, fetch?, timeoutMs? })`
with the namespaces `installation`, `products`, `environments`,
`projects`, `targets`, `clusters`, `health`, `findings`, `schema`,
`drift`; `Result<T>`, `ApiError`; `OPERATIONS` and the generated types;
`clientAssertion`, `algorithmOf`.

**Tests.** `bun run test` (`test/sdk.test.ts`, a scripted `fetch`:
encoding, retries, error mapping, pagination bounds, assertion claims for
five algorithms, token cache and renewal, the leak check over the Wave 4
response types) and the end-to-end run over a real TCP listener in
`apps/server/test/http-registry.int.test.ts`.
