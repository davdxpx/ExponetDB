# Self-observability

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; Wave 2 implementation (§7) accepted with G2 on 2026-10-05 |
| Applies to | Wave 2 (logging, tracing, metrics foundations), every later wave |
| Read before | [`../03-database-model/statement-redaction.md` §6](../03-database-model/statement-redaction.md#6-logs-of-exponetdb-itself), [`../08-auth-and-security/secrets.md`](../08-auth-and-security/secrets.md) |

ExponetDB must be able to explain its own behavior: why a plan was refused,
why an operation is slow, why a sample is missing. It must do that without
becoming a second store of the data it protects.

## 1. Signals

**[DECIDED]** shapes, **[PLANNED]** backends.

| Signal | Format | Destination (V1) | Retention |
|---|---|---|---|
| Logs | structured JSON lines (one event per line), fields below | container stdout → Coolify log collection; optional shipping to the Exponet log store when it exists | 30 days |
| Traces | OpenTelemetry spans (W3C trace context) | OTLP exporter, disabled by default in V1; enabled when an Exponet tracing backend exists | backend-defined |
| Metrics | OpenTelemetry metrics, also exposed as Prometheus text on an internal port | internal scrape (reos-01 private network) | backend-defined |
| Errors | error events with stable codes | Sentry-compatible endpoint, **optional**, with the same redaction as logs | 30 days |
| Audit | not a telemetry signal | Control Store audit tables ([`../02-control-plane/audit.md`](../02-control-plane/audit.md)) | permanent |

Audit and telemetry are separate: telemetry may be sampled, dropped or lost;
audit may not.

## 2. Log fields

| Field | Example | Notes |
|---|---|---|
| `ts`, `level`, `msg` | | `msg` is a stable event name (`operation.step.finished`), not prose |
| `role` | `serve` / `worker` / `gateway` | process role |
| `requestId`, `traceId`, `spanId` | | correlation with API responses (`requestId` is returned in every error) |
| `operationId`, `planId`, `jobId` | `op_01K…` | when applicable |
| `targetId`, `clusterId`, `nodeId` | | ids, never connection strings |
| `actor` | `{kind: human, id: idn_…}` / `{kind: agent, client: cli_…, on_behalf_of: idn_…}` | ids only, no names or e-mail addresses |
| `code` | `PLAN_STALE` | error codes from [`../02-control-plane/error-model.md`](../02-control-plane/error-model.md) |
| `durationMs` | | |

Never logged: secrets, tokens (even hashed), connection strings with passwords,
raw statement text (only redacted text and digests), PostgreSQL `DETAIL`, row
data, request bodies of `data.read`, IP addresses in clear (hashed, as in
audit), cookies, authorization headers. The logger is wrapped with a field
allowlist per event and a pattern denylist as a second line
([`../08-auth-and-security/secrets.md` §2](../08-auth-and-security/secrets.md#2-envelope-encryption)).

## 3. Core metrics

| Metric | Labels | Why |
|---|---|---|
| `exdb_http_requests_total`, `exdb_http_request_duration_seconds` | route template, method, status class, client kind | API health |
| `exdb_mcp_tool_calls_total`, duration | tool, outcome code, client kind | agent behavior |
| `exdb_policy_decisions_total` | rule id, decision | which rules bite |
| `exdb_operations_total` | kind, class, outcome | |
| `exdb_operation_step_duration_seconds` | kind, step | slow steps |
| `exdb_sampler_lag_seconds` | sampler | freshness of health data |
| `exdb_sample_failures_total` | sampler, cause | gaps |
| `exdb_agent_connected` | node | gateway view |
| `exdb_agent_job_duration_seconds` | capability, outcome | |
| `exdb_control_store_query_duration_seconds` | process role, query class | Control Store pressure |
| `exdb_lock_wait_seconds` | domain kind | exclusivity contention |
| `exdb_audit_chain_verified` | scope (`incremental`, `full`) | integrity checks |

Labels never contain target names, user ids or other high-cardinality or
personal values; target-level detail belongs in the Control Store's health
tables, not in metrics.

## 4. Tracing

One trace per API request or MCP tool call, continued into worker steps and
agent jobs (the trace id travels in the signed job envelope as metadata, not as
part of the signed payload's authority). SQL spans record the query **class**
and digest, never text. Sampling: 100 % for errors and for operations, 10 % for
reads (configurable).

## 5. Self-checks

Scheduled checks whose failures become findings on the **installation** subject
(shown in the Web App and in `GET /installation/health`):

- audit hash chain verification (hourly, incremental) and checkpoint export;
- sampler lag and failure rate;
- keyring: exactly one active key, every secret decryptable (sampled);
- certificate expiry of the gateway, issuing CA, job-signing key age;
- Control Store size growth and partition maintenance success;
- clock skew between processes and the Control Store.

## 6. What happens when observability is down

Nothing in ExponetDB's correctness depends on telemetry. If the log shipper,
metrics scraper or tracing backend is down, operations proceed; audit is still
written. If **audit writing** fails, mutations stop (fail closed, C-31).

## 7. Implementation (Wave 2)

**[OBSERVED]** (Wave 2) [`packages/observability`](../../packages/observability/README.md)
and the composition root of [`apps/server`](../../apps/server/README.md):

- **Logs.** One JSON line per event on stdout (one-shot commands log to
  stderr and print their result on stdout). A log line can only carry
  allowlisted fields with validated values (ids must be well-formed ids,
  codes must be tokens; there is no free-text field); unknown or invalid
  fields are dropped and named. A second line of defense, a secret-shape
  denylist, runs over every string. Errors become class, code (ExponetDB
  code or SQLSTATE) and cause code; messages, PostgreSQL `DETAIL`/`WHERE`
  and stacks are never logged. The redaction corpus
  (`packages/observability/test/redaction.test.ts`) covers credential URLs,
  conninfo, `Authorization` and `Cookie` values, JWTs, private keys, cloud
  keys, ExponetDB token prefixes, `PASSWORD '…'` in SQL, IP addresses,
  nested objects, arrays and PostgreSQL errors with statement text; a canary
  proves the sanitizer runs.
- **Metrics.** Prometheus text on each role's internal listener
  (`EXPONETDB_INTERNAL_LISTEN`, default `127.0.0.1:9464`, `/metrics`). Every
  label declares a closed value set or a capped pattern; id-like values
  become `other`. Wave 2 registers `exdb_build_info`,
  `exdb_http_requests_total` and `exdb_http_request_duration_seconds`
  (route template, never the raw path), `exdb_control_store_query_duration_seconds`,
  `exdb_audit_chain_verified`, `exdb_maintenance_task_runs_total` (task,
  outcome) and `exdb_operations_loop_total` (outcome). The other metrics of
  §3 come with the waves that build their subjects.
- **Tracing.** W3C trace context always; OTLP/HTTP export only when
  `EXPONETDB_OTLP_ENDPOINT` is set; span attributes allowlisted; SQL spans
  carry the query class only.
- **Probes.** Public probes on `serve` only, status and request id
  ([`health.md` §8](./health.md#8-control-plane-health)); per-check detail on
  the internal listener (`/healthz/detail`). Readiness checks per role:
  `control_store`, `role_credential`, `installation`, `schema`, `keyring`
  and `heartbeat` (critical); for `serve`, `workers` (a live worker,
  degrading); for `worker`, `audit_export`, `audit_chain` and `maintenance`
  (degrading).
- **Self-checks** (§5) run as worker maintenance tasks under leases, one
  worker per task: audit partitions (6 h), checkpoint and export (hourly,
  export retries every 5 min), incremental (hourly) and full (daily) chain
  verification, plan expiry (1 min), idempotency-key and heartbeat pruning
  (hourly), data-key re-wrapping after a key rotation (10 min). A failure
  is logged by code; a failing export or chain verification, or a task
  failing three times in a row, turns the worker `degraded`. Findings on the
  installation subject come with the Web App (Wave 8). Sampler, certificate
  and clock-skew checks come with the waves that build those parts.
