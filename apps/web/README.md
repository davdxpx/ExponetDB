# @exponetdb/web

The minimal Web App of Waves 3A and 3B
([G3A record](../../exponetdb-docs/14-roadmap/gates/3a.md),
[G3B record](../../exponetdb-docs/14-roadmap/gates/3b.md),
[identity.md](../../exponetdb-docs/08-auth-and-security/identity.md),
[oauth.md](../../exponetdb-docs/05-mcp/oauth.md)): sign-in, first-owner setup,
invitations, out-of-band recovery, the person's own account with its
connected applications, the approval queue, the OAuth consent and device
pages, and the administration of OAuth clients and service accounts. It is a
shell for the identity and delegation foundation, not the Web App of Wave 8
([`11-ui/`](../../exponetdb-docs/11-ui/information-architecture.md)).

## What it is

- Vanilla TypeScript, no framework. One ES module (`app.js`), one
  stylesheet, one HTML page, built by `bun run build` into `dist/` and served
  by `serve` from the same origin (`index.html` for the page routes, the rest
  under `/assets/`).
- `@simplewebauthn/browser` is bundled into `app.js`. No script, style, font,
  image or QR code comes from another origin; the TOTP QR code is drawn
  locally from the matrix the server sends.
- The server sends a strict CSP (`default-src 'none'; script-src 'self';
  style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action
  'self'; base-uri 'none'; frame-ancestors 'none'`) and `Cache-Control:
  no-store` with every page and asset
  ([`web.ts`](../server/src/interfaces/http/web.ts)). The build refuses a
  bundle that evaluates strings or names another origin.
- Untrusted text (names, labels, device strings, change content) is set with
  `textContent` only; there is no `innerHTML`.

## Pages

| Path | What |
|---|---|
| `/login` | passkey first (discoverable credential, nothing to type); password with TOTP or a recovery code as fallback; every failure reads the same |
| `/setup`, `/invite`, `/recover` | one-time links: the token is read from the fragment, removed from the address bar and history at once, and redeemed; passkey, password and authenticator app; recovery codes shown once |
| `/account` | own identity and roles, passkeys, password, authenticator app, recovery codes, sessions, connected applications (each grant with client, resource, scopes, tiers, expiry and last use; revocable at once); actions that need a recent proof ask for it (passkey or TOTP) and run once more. A recovery session shows no connected applications (it may only replace factors) |
| `/approvals` | operations awaiting approval with the exact change and analysis; approve or reject the reviewed plan hash; own plans need an explicit acknowledgement (OD-9) |
| `/oauth/consent` | the decision on a pending authorization request (`#request=exar_…`, bound to the browser by the `__Host-exdb_oauth` cookie): the client's name as untrusted text ("name not verified" unless first party), a lookalike warning, the exact `client_id`, the host the code goes to, the resource, the scopes offered (never more than the person holds; MCP-ineligible scopes are never offered), the tiers (production opt-in with an explicit acknowledgement) and the lifetime; allowing needs a proof at most 5 minutes old. No remote logo is loaded |
| `/oauth/device` | the person types the code the device shows (never taken from a link), checks it, then decides as on the consent page |
| `/oauth/error` | fixed text for the reason the authorization endpoint could not redirect back (`?reason=` from a fixed list; nothing from the request is echoed) |
| `/admin/clients` | OAuth clients: fetch a Client ID Metadata Document by its exact URL for review, approve the exact metadata fingerprint, reject, disable, fetch again; pending DCR registrations with their requester pseudonym and expiry |
| `/admin/service-accounts` | service accounts: create (no role, no credential), register the `private_key_jwt` client with a public JWKS, replace keys, create the machine grant, create API keys (the key is shown once), revoke API keys |

`returnTo` after sign-in accepts only `/account`, `/approvals` (with an
optional `#operation=op_…` fragment), `/oauth/consent#request=exar_…`,
`/oauth/device`, `/admin/clients` and `/admin/service-accounts`; anything
else falls back to `/account` ([`safe.ts`](./src/safe.ts)). The server
decides who may see and change what; the administration pages only show
what `/api/v1` returns. The CSRF header comes from the
readable CSRF cookie; the session cookie is `HttpOnly`.

## Tests

`bun run test`: the trust rules (`returnTo`, link tokens, request handles,
authorization error text, CSRF cookie, QR path). The browser end-to-end suite runs the built app in Chromium with a
virtual WebAuthn authenticator against the real `serve` role and PostgreSQL
17: `bun run test:e2e` at the root
([`web.e2e.test.ts`](../server/test/web.e2e.test.ts)).

## Allowed dependencies

`contracts` (types only, `import type`) and `@simplewebauthn/browser`; never
a server package (`tooling/boundaries/graph.json`).
