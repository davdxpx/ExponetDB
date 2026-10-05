# Self-observability

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
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
| `exdb_audit_chain_verified` | partition | integrity checks |

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
