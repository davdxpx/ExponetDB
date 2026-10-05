# @exponetdb/web

The minimal Web App of Wave 3A
([G3A record](../../exponetdb-docs/14-roadmap/gates/3a.md),
[identity.md](../../exponetdb-docs/08-auth-and-security/identity.md)): sign-in,
first-owner setup, invitations, out-of-band recovery, the person's own
account and the approval queue. It is a shell for the identity foundation,
not the Web App of Wave 8 ([`11-ui/`](../../exponetdb-docs/11-ui/information-architecture.md)).

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
| `/account` | own identity and roles, passkeys, password, authenticator app, recovery codes, sessions; actions that need a recent proof ask for it (passkey or TOTP) and run once more |
| `/approvals` | operations awaiting approval with the exact change and analysis; approve or reject the reviewed plan hash; own plans need an explicit acknowledgement (OD-9) |

`returnTo` after sign-in accepts only `/account` and `/approvals` (with an
optional `#operation=op_…` fragment); anything else falls back to
`/account` ([`safe.ts`](./src/safe.ts)). The CSRF header comes from the
readable CSRF cookie; the session cookie is `HttpOnly`.

## Tests

`bun run test`: the trust rules (`returnTo`, link tokens, CSRF cookie, QR
path). The browser end-to-end suite runs the built app in Chromium with a
virtual WebAuthn authenticator against the real `serve` role and PostgreSQL
17: `bun run test:e2e` at the root
([`web.e2e.test.ts`](../server/test/web.e2e.test.ts)).

## Allowed dependencies

`contracts` (types only, `import type`) and `@simplewebauthn/browser`; never
a server package (`tooling/boundaries/graph.json`).
