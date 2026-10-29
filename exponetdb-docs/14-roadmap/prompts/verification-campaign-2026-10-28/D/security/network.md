# Network (Block D, tester S4)

Mostly **NOT RUN**. The tester's turn was cut by a safety classifier right after the hostile-input cases of task 4 had run; the
rest of the planned work with hostile payloads (the SSRF and rebinding fixtures of task 5) was not started afterwards, so that no
withheld content is produced again. What follows is what was observed before that, plus the exact list of what is missing.

## Observed

| Check | Result |
|---|---|
| Target unreachable (loopback port rejected), query, drift check, health | named code `TARGET_UNAVAILABLE`; no secret in the answer (canary scan clean) |
| Target stops offering TLS (the product connects with verify-full), query and drift check | named code `TARGET_TLS_FAILED`; clean |
| Stored credential no longer matches the database | `TARGET_CREDENTIAL_INVALID` ("needs rotation or repair"); clean |
| Missing operator credential for `connections.cancel` / `terminate` | the same code `TARGET_CREDENTIAL_INVALID`; the message suggests rotation although no credential exists (finding 6) |
| OAuth discovery | `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint` (DCR), `device_authorization_endpoint`, PKCE `S256` only, `client_id_metadata_document_supported: true`, auth methods `none` and `private_key_jwt` |
| Device flow without a `resource` parameter | 400 `invalid_target` (the CLI's own device login worked and was approved by the owner) |
| DCR registration with a loopback redirect | 201, usable after the person's consent (open registration is the lab's setting) |
| Internal listeners (`/metrics`, `/healthz/*`) | bound to 127.0.0.1 on three ports; 447 KB / 420 KB / 68 KB of metrics, no canary |
| Public listener | `/healthz/ready`, discovery, OpenAPI (840 KB), the SPA; `/metrics` is 404 there |

## NOT RUN

- SSRF through CIMD (client-metadata-document URLs) and DCR logo/jwks URLs: loopback, link-local, private ranges, a redirect to a
  private address, a name that resolves to a private address after validation (rebinding), a non-JSON media type, a body above
  5 KiB. Reason: stopped by the classifier before the fixtures were written; nothing was sent. The code to read first:
  `packages/auth/src/oauth/fetch.ts` and `metadata.ts` (the CIMD fetch) and `exponetdb-docs/05-mcp/oauth.md`.
- Webhook or notification URLs: none exist on this stack (OD-21, break-glass and notifications are not configured).
- TLS downgrade between the product and a target (`sslmode=prefer` against `verify-full`): the product only offers `verify-full`
  in the registry; no way to select a weaker mode was found in the contract, and none was tried.
- The gateway with a revoked node, and an agent that talks to a wrong server (wrong gateway CA): not started. These are the two
  tests of this task that most need the lab's node agent and are cheap to add to `B/failure` or here later.
