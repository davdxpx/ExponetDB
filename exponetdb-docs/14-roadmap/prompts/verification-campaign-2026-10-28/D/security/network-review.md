# Network: SSRF review, validators as pure functions, TLS, the gateway with a revoked node (tester S7)

Block D "Network". Tree `d51da5d0`. Method: code review of every place where the server fetches a URL or connects to a host that someone else
supplies, 241 unit-level cases against the product's own validators (read-only import of the sources on the stack's checkout), a local
refusal check through the real authorization endpoint, and three normal operations on the stack (target certificates, the gateway with a
revoked node). **No P0.** Replaces the NOT RUN of S4's `network.md` for these items. No DNS rebinding server was built (brief).
Scripts: `scripts/s7-net-validators.ts`, `s7-cimd-local.sh`, `s7-target-tls.sh`, `s7-gateway-revoked.sh`; raw logs on the server.

## 1. Where the server connects to something an outsider names

| # | Place | Who supplies the host | What is validated | Resolve, then connect | Verdict |
|---|---|---|---|---|---|
| 1 | CIMD client metadata document (`packages/auth/src/oauth/fetch.ts`); reached by an administrator's registration and, under open registration, by **any unauthenticated request** to `/oauth/authorize` with an unknown `client_id` URL | untrusted | exact `https` URL of a DNS name (no IP literal of any spelling, no `localhost`, `.local`, `.internal`, `.localhost`, no port, no userinfo, no query/fragment, canonical spelling, 512 characters); every resolved address public (v4 deny-list of 15 ranges, v6 only `2000::/3` minus `2001::/23`, `2001:db8::/32`, `2002::/16`, `3fff::/20` (the other listed v6 ranges lie outside it anyway), v4-mapped judged as v4); one `GET`, no redirect, status 200, JSON media type parsed as RFC 9110, no content encoding, 5 KiB counted on the wire, 5 s for resolve plus exchange, TLS 1.2+ verified for the name | resolve **once**, all answers checked, connect to the **first** answer by address with SNI and verification by name; no second resolution | **PASS**, no static finding |
| 2 | DCR and CIMD members `jwks_uri`, `jwks`, `logo_uri`, `tos_uri`, `policy_uri`, `contacts` | untrusted | `jwks`/`jwks_uri` refused (`keys_not_allowed`); the others are accepted and **dropped** (only `client_name`, `client_uri`, `software_id`, `software_version` are stored); nothing else is ever fetched | n/a: no fetch | PASS |
| 3 | OAuth redirect URIs | untrusted | exact match, https or loopback http; the server never connects to them (the browser does) | n/a | PASS |
| 4 | Target connection (`packages/postgres/src/session.ts`) | semi-trusted: `registry.manage` registers host and port | DNS name or IP (`^[A-Za-z0-9.:-]+$`), port 1..65535, TLS server name must be a DNS name; **always `verify-full`** against the endpoint's own CA bundle, no sslmode choice, no plaintext fallback, SCRAM only; `system_identifier`, database and marker guards after connect | the driver connects **by name** (resolve inside `net.connect`); a rebinding to another machine fails the certificate for the registered name and the `system_identifier` guard | PASS (see 1.1) |
| 5 | Audit export to S3 (`packages/audit/src/export/s3.ts`) | trusted: operator environment variable | `https`, or `http` only for a loopback host; no userinfo; bucket, region, prefix patterns; `redirect: 'error'`, 10 s timeout | global `fetch` by name, no pin | PASS: no untrusted input reaches it |
| 6 | Backup repository `endpointHost` (`packages/backups/src/plans.ts:122-148`) | semi-trusted: a person plans the adoption | lowercase DNS name with a dot, no `.local/.localhost/.internal/.invalid/.test/.example` suffix (S2's finding), checked again by a CHECK constraint | **the Control Plane never connects**: the value is recorded and printed into the offline runbook (`SAFE.host`); the real endpoint is in the host's own pgBackRest/restic configuration | PASS (the suffix list is cosmetic: `127.0.0.1` and `169.254.169.254` match the host regex; harmless because nothing connects) |
| 7 | Webhooks, notification channels, OIDC/IdP discovery | n/a | none exist: the notification interface has no implementation (OD-21), the docs' "federated IdP metadata" is not built; `grep` for `fetch(`, `http.request`, `net.connect`, `tls.connect` in `apps/*/src`, `packages/*/src`, `agent` finds only rows 1, 4, 5 and test/CLI code | n/a | PASS (nothing to attack) |
| 8 | OTLP exporter (`EXPONETDB_OTLP_ENDPOINT`) | trusted: operator environment | `http` or `https` URL | n/a | PASS |
| 9 | Gateway (`apps/server/src/interfaces/gateway/agent-listener.ts`) | the Control Plane listens; the node dials in | HTTP/2 over TLS 1.3 only, client certificate requested, `rejectUnauthorized: false` by design (enrollment has none), then every route checks `socket.authorized` and the certificate's node | n/a | PASS, see 3 |

### 1.1 Static remarks (none above P3)

- Row 4: there is **no address policy** for targets, by design ("private by nature"). A holder of `registry.manage` can register a host and port
  on the Control Plane's network and learn from the error class whether something listens (`TARGET_UNAVAILABLE` closed, `TARGET_TLS_FAILED` open
  but not a TLS PostgreSQL). Registration is a planned, audited, step-up action, so this is a port-scan oracle for an already privileged person,
  not an SSRF by an outsider. Recorded as an open decision (egress policy of the Control Plane host is the control, not the product).
- Row 1 is rate limited per address (10 per hour, an HMAC of the client address) and in total (`dcr-all`, 100 per hour). A set of ten addresses can
  therefore keep every other new client from being discovered for the hour (availability only). Every attempt that passes the URL syntax check counts,
  also the ones the address policy then refuses (verified: three syntactically valid names raised the counter by three).
- Row 1: `fetchClientMetadata` re-fetches a stale cache (`refreshCimdClient`); a registered client whose name later resolves to a private
  address is refused at that refresh and the authorization is refused (`client_unknown`): the address check is repeated on every fetch.
- `systemNetwork()` resolves with `dns.lookup` (getaddrinfo: `/etc/hosts`, `nsswitch`, search list). Names resolve the way the host does; the
  address policy sees the result, so a hosts-file entry cannot make an internal address pass.

## 2. The validators as pure functions: 241 cases, 0 FAIL

`scripts/s7-net-validators.ts` (Bun 1.4.4; the fetcher runs against the product's own TLS test world, `packages/auth/test/support/tls.ts`, imported read-only). Groups:

| Group | Cases | What |
|---|---|---|
| A. `isPublicAddress` | 83 | 67 refused forms: `127.0.0.1`, `127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1` (all four non-canonical spellings are not IP literals and are refused), `::1`, `[::1]`, `::`, `0.0.0.0`, `::ffff:127.0.0.1`, `::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1`, `::ffff:169.254.169.254`, `::127.0.0.1`, `::ffff:0:127.0.0.1`, NAT64 of loopback and of metadata, 6to4, Teredo, `169.254.169.254`, both ends of CGNAT, 10/8, 172.16/12, 192.168/16, 192.0.0/24, benchmarking, documentation ranges, multicast, reserved, broadcast, `fc00::/7`, `fd00:ec2::254`, `fe80::/10` with and without a zone id, `fec0::/10`, `ff02::1`, `100::/64`, `2001:db8::/32`, `3fff::/20`, `5f00::/16`, empty string, names, short dotted forms, 5 groups, octet 256, leading/trailing space and newline, `::1` spelled long; plus 16 accepted public forms (`8.8.8.8`, `172.32.0.1`, `172.15.255.255`, `100.128.0.1`, `100.63.255.255`, public v6 in three spellings, `::ffff:8.8.8.8`, `2001:200::1`, `3ffe::1`, ...) so the list is not simply "refuse everything" |
| B. `parseMetadataUrl` | 74 | http, upper-case scheme, ftp, file, scheme-relative, every IP literal form above as a host, `localhost`, `localhost.`, `LOCALHOST`, `.localhost/.local/.internal`, `metadata.google.internal`, trailing-dot FQDN, userinfo (also `client.example.com@127.0.0.1`), ports 443/8443/80, `/` or no path, query, fragment, dot segments (also percent-encoded), spaces, tabs, newline, NUL, backslash, upper-case host, IDN in Unicode, a Cyrillic lookalike, numeric last label, underscore, leading hyphen, double dot, one label, 64-character label, over 512 characters (65 refused), 9 accepted: plain, deep path, punycode host, trailing slash, `%7E`, a `.test` name, and two **names that resolve to loopback** (`127.0.0.1.nip.io`, `localtest.me`) which only the address check stops (shown in D1) |
| C. `isJsonMediaType` | 25 | `application/json` in four spellings and `+json`; `text/json`, `text/plain`, `application/json.evil`, `application/x+json.evil`, `application/+json`, `application/jsonp`, a list, spaces around the slash, NUL, empty, undefined, `charset=utf-16/latin1`, a boundary parameter |
| D. `fetchMetadataDocument` | 56 | **resolve count is exactly 1**; connect goes to the first resolved address only; rebinding (1st answer public, 2nd private): the second answer is never asked for and never used; round robin with one private answer: refused, no connect; private answer first, public second: refused; empty and failing resolver: `dns_failed`; hanging resolver: `timeout`; 12 private answers (loopback, v4-mapped in both spellings, metadata, CGNAT, 10/8, 172.16/12, 192.168/16, ULA, `fd00:ec2::254`, link-local): `address_refused` and **zero connections**; the system resolver's answers for `localhost` are non-public; every redirect status 301/302/303/307/308/304 with a `Location` at a private address: `redirect_refused`, one connection, the target never contacted; 201/202/204/206/401/403/404/500: `status_refused`; media types on the wire; no Content-Type, gzip, invalid UTF-8; bodies of 5119, 5120 (pass), 5121, 65536, 1,000,000 (too large); chunked 1 MiB without length; 60 KB header block; slow drip body against a 1 s budget and a server that never answers: `timeout`; certificate from an untrusted CA and a certificate for another name: `tls_failed`; the request carries no cookie, no authorization, no forwarded header, `Accept: application/json, application/*+json`, `Accept-Encoding: identity` |
| E. members that name a second URL | 3 checks, 5 notes | `jwks_uri`/`jwks`: `keys_not_allowed`; `logo_uri`, `tos_uri`, `policy_uri`, `contacts`: accepted and not stored; `client_uri`: stored as text; redirect URIs with a private host are data |

One expectation of mine was wrong (`%7E` is kept verbatim by the WHATWG parser, so it is canonical and accepted; harmless in a path). It is now in the accepted list with that note.

## 3. The product's own refusal test, through the real endpoint (stack, open registration)

`scripts/s7-cimd-local.sh`: ten `GET /oauth/authorize` requests with a CIMD `client_id` that points at this machine or is malformed
(`https://127.0.0.1/`, `localhost`, `[::1]`, `169.254.169.254`, decimal, userinfo, `http`, `localtest.me`, `127.0.0.1.nip.io`, an unresolvable name).

- All ten answered `302 /oauth/error?reason=client_unknown`: **the same answer for every reason**, so the endpoint is no oracle for what the
  server could or could not reach.
- No client was created (`oauth.clients` count 0 for these ids); the three names that passed the URL syntax check took 0.02 s, 0.4 s (real DNS, refused by the
  address policy) and 0.03 s.
- **P3 (finding):** the refusals leave **no audit event and no log line** (0 serve journal lines mentioning CIMD, 0 audit rows `oauth.client*`). The
  only trace is the rate counter. An administrator cannot see that someone pointed the authorization endpoint at `169.254.169.254` ten times.
  The reason (`address_refused`, `redirect_refused`) exists in the code (`MetadataFetchError.reason`) and is thrown away at `cimdRefresher.discover`.

## 4. TLS between the product and a target (stack, normal operation)

The registry offers no sslmode: every session is `verify-full` with the endpoint's CA bundle, TLS 1.2+, no plaintext fallback (S4 saw `TARGET_TLS_FAILED`
when the server stopped offering TLS). `scripts/s7-target-tls.sh` replaced the server certificate of the PG18 lab cluster
(the stack's PostgreSQL stays plaintext-tolerant in `pg_hba`, so a fallback would have worked had one existed) and waited out the product's
circuit breaker (3 failures in 60 s open it for 30 s) before each probe:

| Server certificate | First call (JSON) | Later calls within 30 s and `target show` | Plaintext fallback | Verdict |
|---|---|---|---|---|
| original | ok | ok, `Health: healthy` | - | baseline |
| expired (CA-signed, valid only in January) | `TARGET_TLS_FAILED` "TLS verification of the target failed.", no remedy, `details` empty | `TARGET_UNAVAILABLE` "cannot connect", `Health: unreachable` | none | PASS (refused) |
| valid, other name (`other.exdb.test`) | `TARGET_TLS_FAILED` | `TARGET_UNAVAILABLE` | none | PASS |
| self-signed (untrusted) | `TARGET_TLS_FAILED` | `TARGET_UNAVAILABLE` | none | PASS |
| valid, **expires in 2 days** | ok | ok, `Open findings: 0` | - | works as it should; **no warning anywhere** |
| original restored | ok | ok | - | recovers inside one breaker window |

Findings (both P3, observability): (1) **the cause is lost**: only the first failing call says TLS; afterwards, and in `target show`, the operator reads
"cannot connect" and "unreachable" (the circuit breaker answers `TARGET_UNAVAILABLE`/`circuit_open` without the cause), nothing says
expired, wrong name or unknown CA, and `TARGET_TLS_FAILED` carries no remediation; (2) **a target certificate that expires in two days raises no
finding, no health condition and no log line**; the first symptom is the outage. Not a gap against a promise (`credentials-and-roles.md` §6 does
not promise expiry monitoring), but the first 3 a.m. surprise: a proposal.

## 5. The gateway with a revoked node

`scripts/s7-gateway-revoked.sh` revoked the stack's only node agent (`node revoke`: plan class `high`, one passkey step-up, no approval required) and
watched for 30 s, then probed. **PASS: the gateway refuses it at its next request, the Control Plane stops sending it work, the revocation is audited.**

| Observation | Result |
|---|---|
| Revoke operation | `succeeded` in 3 s (plan 23:46:54, applied 23:46:57); `node status` is `revoked` from the first poll on |
| Next request of the agent | refused within 1 s: gateway answers `403 NODE_CERTIFICATE_REFUSED` ("The client certificate is not the node's current certificate, or the node's state ..."); then `hello` is refused again at +2 s, +3 s, +9 s, +17 s (4 to 11 ms each; the agent backs off, three more attempts in the following minute) |
| The long poll that was open at the revocation | it ended with the 403 about 11 s after it started (`durationMs: 11059`, the claim in flight); it handed out no job |
| Gateway log | `agent.refused` at `info` with `nodeId`, route, `code` and duration for every refusal; no certificate or token content |
| Agent log | `WARN session ended ... gateway 403 NODE_CERTIFICATE_REFUSED` on every attempt; the agent does not stop and does not say what to do (re-enroll) |
| Node-bound calls from the CLI | `node inspect` and `backup refresh`: `NODE_REVOKED` "The node identity was revoked.", no remedy (nothing is queued); `node show`: `state: revoked` |
| Audit | `plan.created`, `operation.accepted` (human, CLI), `node.revoke` and the state changes (system). **No audit event and no finding for the refused requests of the revoked node**; they exist only as gateway log lines (level `info`) |

Finding (P3): a revoked node that keeps knocking is the signal of a copied credential or a forgotten host, and it is not in the audit trail,
raises no finding and no metric alert is documented for it. The gateway log line is enough for a log-based alert, but only if the operator knows
the line name (`agent.refused` with `NODE_CERTIFICATE_REFUSED`). Also (decision): revoking is a single-person step-up action for the only
node of an installation; its cluster's backups and host operations are unreachable until a node is enrolled again.

State left on the stack: **the node is revoked**; agent-based tests (backup, restore, node capabilities) on this stack need a new enrollment
(`stack-down.sh` and `stack-up.sh` rebuild it). I ran this last for that reason.

## 6. Open decision

An egress policy for the Control Plane host (what a person with `registry.manage` may point it at) is not in the product. Today the product
relies on `verify-full` + the identity guards after connect; the owner may want a documented deny-list for the host's firewall. In `F/decisions-S7.md`.
