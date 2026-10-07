# Node agent security

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 5 |
| Read before | [`architecture.md`](./architecture.md), [`../08-auth-and-security/threat-model.md`](../08-auth-and-security/threat-model.md) |

The node agent runs on the most sensitive machine in the system: the host with the
production data. Its design assumes that **any** single component around it can be
compromised, and asks what that component can then do.

## 1. Compromise scenarios

| Compromised component | What it can do | What it cannot do | Why |
|---|---|---|---|
| Gateway process | see heartbeats and job envelopes (not sealed values); withhold, delay or reorder jobs; drop results; forge unsigned observations | forge or alter jobs; read sealed secrets or target credentials; forge node results; bind a rogue node | jobs signed by the worker's key; the gateway's DB role can read only the issuing CA key, never target credentials or the job-signing key; node certs bound to node keys |
| Network between host and gateway | observe metadata | read or modify messages | mutual TLS 1.3; root CA pinned on the agent |
| A stolen node certificate (without key) | nothing | — | TLS needs the private key |
| A stolen node key + certificate (host compromise) | everything the host could do anyway | affect other nodes | per-node identity; revocation through node state |
| Agent process (unprivileged) | run its compiled capabilities; superuser SQL via local socket; read PostgreSQL logs | run arbitrary shell or root commands | helper accepts only typed, allowlisted operations; no sudo; systemd hardening |
| Helper process | root on the host | be reached from the network | `AF_UNIX` only, `SO_PEERCRED` check |
| Control plane worker (job-signing key) | issue any job any capability allows | issue a shell command, read arbitrary files, run arbitrary SQL on the host | capability catalog is the ceiling (C-22) |
| Control Store (database) | change node records, enqueue jobs | sign jobs | signing key is not in the Control Store in plaintext; it is loaded by the worker from the secret store with the master key (outside the database) |

**[DECIDED]** (OD-23, 2026-10-07, [ADR-0024](../01-architecture/adr/0024-node-trust-model.md))
The gateway row holds through these controls: job-signing keys anchored in
the enrollment token, node keys bound through the token secret and verified
by the worker, node-signed results (`nr1`) and sealed secrets (`ns1`). A
compromised gateway (or its issuing CA) can still withhold, delay, reorder
and drop jobs and results, read non-secret job arguments and forge unsigned
observations such as heartbeats, which never decide an operation.

The capability catalog is the **ceiling of damage** for a compromised control
plane: the worst a fully compromised control plane can do on a database host is
the worst combination of capabilities (for example: change configuration, restart
PostgreSQL, rotate TLS, change roles, run a restore into scratch). That is serious
(availability, role changes) and is why role changes and restarts on prod tier
need human approval, but it does not include reading arbitrary files, installing
arbitrary software, or opening a shell.

## 2. Controls

**[DECIDED]**

1. No inbound ports; outbound mTLS only.
2. Root CA pinning on the agent; no Web PKI trust for the gateway.
3. Short-lived client certificates (72 h), host-generated keys, rotation on renewal.
4. Job signatures (Ed25519) by a key held only by the worker; key rotation via
   signed `config.update` with overlap.
5. Replay protection: job id journal, nonce cache, expiry, node binding.
6. Privilege separation: unprivileged agent + root helper with typed operations.
7. Capability input schemas validated on the agent (not only in the control plane).
8. Allowlists for unit names, file destinations, package names.
9. No plaintext secrets in jobs: SCRAM verifiers and (Wave 9) backup
   repository credentials are sealed to the node's bound encryption key
   (`ns1`).
10. Local redaction of logs before they leave the host.
11. systemd hardening, resource limits, no core dumps (`LimitCORE=0`).
12. Audit on the control plane for every job; local journal on the host as a
    second record (retained 90 days).
13. Supply chain: reproducible builds where feasible, signed packages, SBOM
    published with each release, dependency review for the Go module.

## 3. Superuser on the host

**[DECIDED]** The agent's PostgreSQL role `exponetdb_node` is a superuser that can
log in only through the local socket with `peer` authentication from the agent's
OS user. This is accepted because:

- capabilities that change roles, extensions, configuration, `pg_hba` and
  restores need superuser or equivalent;
- the agent already runs on the host; an attacker with the agent's OS user could
  also use the local socket;
- keeping superuser **off the network** is the meaningful boundary (C-21).

Hardening options for later: replace superuser with granular privileges where
PostgreSQL offers them (`GRANT ALTER SYSTEM ON PARAMETER …` since PostgreSQL 15, if
[OD-20](../00-product/open-decisions.md#od-20-postgresql-configuration-ownership-strategy) chooses `ALTER SYSTEM`,
`pg_signal_backend`, `pg_checkpoint`, `pg_maintain` since 17), leaving superuser
only for role and extension management.

## 4. Things the agent refuses even if asked by a valid job

- Restoring over the data directory of a running registered cluster (V1).
- Changing the PostgreSQL major version through packages.
- Installing packages outside the allowlist.
- Writing files outside the allowlisted destinations.
- Applying a job whose cluster `system_identifier` does not match the local
  cluster.
- Executing when the clock skew exceeds 30 s.
