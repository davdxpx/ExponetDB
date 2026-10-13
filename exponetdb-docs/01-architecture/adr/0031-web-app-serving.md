# ADR-0031: Serving the Web App: SPA fallback, hashed immutable assets, precompression

| | |
|---|---|
| Status | Proposed (Wave 8 Phase 1; in force for the wave, confirmed or changed by the owner at G8) |
| Date | 2026-10-13 |
| Related | [ADR-0019](./0019-process-roles-and-web-app.md), [ADR-0030](./0030-supabase-ui-source-adoption.md); [`../../08-auth-and-security/threat-model.md`](../../08-auth-and-security/threat-model.md) (T23, Wave 8 section); [`../../12-operations/deployment.md`](../../12-operations/deployment.md); the [Wave 8 order](../../14-roadmap/orders/wave-8-order.md) §9 first row; [G8 record](../../14-roadmap/gates/8.md) |

## Context

**[OBSERVED]** (`apps/server/src/interfaces/http/web.ts` at `9fb063b`) `serve`
answered a fixed list of page paths (`WEB_PAGES`, duplicated in
`apps/web/src/safe.ts`) with `index.html`, served a flat directory of
`.html .js .css .svg` files under `/assets/`, sent `Cache-Control: no-store`
on everything, copied every body per request, and compressed nothing.

The Wave 8 Web App is a single-page application with a client router, route
level code splitting, self-hosted fonts and (for the SQL editor) workers.
Its routes include stable deep links (`/t/<product>/<project>/<environment>/…`,
`/changes/plans/<id>`) that a fixed server list cannot enumerate, its bundle
is hundreds of kilobytes before compression, and its file names carry
content hashes with upper-case letters, `_` and `-`.

## Decision

1. **SPA fallback.** A `GET` or `HEAD` that no route matched answers with
   `index.html` when its path is outside the namespaces `/api`, `/auth`,
   `/oauth`, `/mcp`, `/.well-known`, `/healthz`, `/metrics`, `/schemas` and
   `/assets` (case-insensitive, repeated slashes collapsed) and its last
   segment has no dot. The three OAuth ceremony pages (`/oauth/consent`,
   `/oauth/device`, `/oauth/error`) are the only page paths inside an
   excluded namespace. Every other request keeps the `NOT_FOUND` problem,
   so unknown API and protocol paths stay truthful 404s. A path the client
   router does not know renders a "page not found" state in the page. The
   server keeps no list of client routes (`WEB_PAGES` is removed).
2. **Asset layout.** The build writes `index.html` and `assets/`. The entry
   files `assets/app.js` and `assets/app.css` keep fixed names and are
   `no-store`, like the page; content-hashed files live in
   `assets/chunks/` (scripts and workers) and `assets/files/` (styles,
   fonts, images) and are served `public, max-age=31536000, immutable`.
   Files next to `index.html` are still served below `/assets/` (the flat
   layout of the Wave 3A build).
3. **Loading.** `serve` loads the build once at start into memory: regular
   files only (no symbolic links), names of `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`
   per segment, at most three directory levels below `assets/`, and only
   `.js .css .svg .woff2` (plus `index.html`). A request never reaches the
   file system; an asset is a map lookup.
4. **Precompression.** The build writes `.br` and `.gz` next to each text
   file; `serve` sends the best one the request accepts (`br` before
   `gzip`, never a coding with `q=0`) with `Content-Encoding` and
   `Vary: Accept-Encoding`. No compression happens per request.
5. **Headers.** Every page and asset carries the Web App's security headers
   (CSP, COOP, CORP, `Permissions-Policy`, `Referrer-Policy: no-referrer`,
   `nosniff`, `X-Frame-Options: DENY`). The CSP gains `font-src 'self'` and
   `worker-src 'self'` (order D9) and stays without `unsafe-*`, nonces,
   hashes, `blob:` or other origins. The base middleware sets `no-store`
   only where a handler set no `Cache-Control` of its own.
6. **No ETag.** `no-store` responses are never revalidated and immutable
   ones never need to be; an ETag would add nothing.

## Alternatives considered

- **A server-side copy of the client route table.** Rejected: the table
  already drifted once (`WEB_PAGES` vs `safe.ts`), and target paths are data.
- **Fallback for every unmatched path.** Rejected: an API client asking for
  an unknown resource would get an HTML page with status 200.
- **Compression by the proxy (Traefik).** Not assumed: the Coolify proxy on
  `reos-01` is not configured to compress, and precompressed files cost no
  CPU per request.
- **Everything `no-store`.** Rejected for hashed files: each navigation
  would download the whole bundle again; their content never changes under
  the same name.

## Consequences

- One rule decides what is a page; the parity of the earlier pages and
  their URLs no longer depends on a server list.
- Hashed assets are cached by browsers for a year; a new release changes
  their names. The entry files and the page are fetched fresh, so a release
  takes effect on the next navigation.
- Tests: `apps/server/test/web.test.ts` (fallback, namespaces, loader,
  caching, encodings, CSP), the browser suites, `tooling/smoke/roles.sh`
  (a client route returns the page; an unknown API path stays a problem).
