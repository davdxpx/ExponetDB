# @exponetdb/observability

Self-observability foundations of the Control Plane
([self-observability.md](../../exponetdb-docs/10-observability/self-observability.md),
[health.md §8](../../exponetdb-docs/10-observability/health.md#8-control-plane-health)).
Telemetry is not audit: it may be sampled, dropped or lost; nothing in
ExponetDB's correctness depends on it.

## Owns

| Module | What |
|---|---|
| `logger.ts` | structured JSON lines (`ts`, `level`, `msg` = stable event name, `role`, fields); field **allowlist** with typed validators (ids must be well-formed ids, codes must be tokens, no free text); unknown or invalid fields are dropped and named in `droppedFields` |
| `redact.ts` | secondary **denylist** of secret shapes applied to every logged string: private keys, credentials in URLs, `Authorization`/`Cookie` values, bearer/basic tokens, JWTs, ExponetDB token prefixes, cloud and SaaS keys, `key=value` secrets (query strings, conninfo, JSON), SQL `PASSWORD '…'`, IPv4 and IPv6 addresses |
| `errors.ts` | `describeError`: errors become `{errorName, errorCode, causeCode}`; messages, PostgreSQL `DETAIL`, `WHERE` and stacks never leave; `SafeError` carries a constant message written by ExponetDB |
| `context.ts` | request correlation (`requestId` = `req_<ULID>`, `traceId`, `spanId`) through `AsyncLocalStorage` |
| `metrics.ts` | registry of counters, gauges and histograms rendered as Prometheus text; every label declares a closed value set or a pattern with a distinct-value cap; id-like values (prefixed ids, ULIDs, UUIDs) become `other` |
| `tracing.ts` | OpenTelemetry: W3C trace context always; OTLP/HTTP export only when an endpoint is configured (otherwise no-op spans, no startup failure); span attributes allowlisted; errors set status to the code only |
| `health.ts` | liveness vs readiness; named checks (`critical` / `degrading`), timeouts, a throwing or hanging check counts as failed; public projection is the status only |
| `error-sink.ts` | optional error reporting interface (Sentry-compatible transports can implement it); receives only the safe error projection |

## Does not own

Audit (`@exponetdb/audit`), the HTTP probe routes (`apps/server`
interfaces), what each role checks (composition root).

## Allowed dependencies

`@exponetdb/kernel`; OpenTelemetry (`api`, `core`, `context-async-hooks`,
`sdk-trace`, `resources`, `exporter-trace-otlp-http`). No vendor SDK.

## Public API

`createLogger`, `sanitizeFields`, `redactText`, `describeError`, `SafeError`,
`withCorrelation`, `newRequestId`, `MetricsRegistry`, `LABELS`,
`setupTracing`, `Readiness`, `pass`/`warn`/`fail`, `publicReadiness`,
`readinessHttpStatus`, `reportError`.

## Security properties

- A log line can only contain allowlisted fields with validated values, and
  every string is scanned by the denylist (two lines of defense); the
  redaction corpus in `test/redaction.test.ts` proves both, including nested
  objects, arrays, `Error` objects and PostgreSQL errors with statement text.
- Metric labels never carry target, identity, plan or operation ids.
- Readiness reasons are machine codes; free text is replaced by `unspecified`.

## Failure behavior

Logging, metrics, tracing and error reporting never throw into the caller.
A missing OTLP endpoint disables export; a down collector loses spans only.
