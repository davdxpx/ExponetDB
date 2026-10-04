# Control Plane and Data Plane

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Read before | [`overview.md`](./overview.md) |
| Decision | [ADR-0002](./adr/0002-control-plane-data-plane.md), [ADR-0005](./adr/0005-own-control-store.md) |

> PostgreSQL remains the Data Plane. ExponetDB is the Control Plane.

## 1. Definitions

| | Control Plane | Data Plane |
|---|---|---|
| What | ExponetDB processes, Control Store, node agents (as executors of control decisions) | Managed PostgreSQL clusters and their databases |
| Holds | inventory, identities, policies, plans, operations, ledger mirrors, samples, audit | application data, the per-target ledger (`exponetdb` schema) |
| Traffic | management: inspections, plans, operations, samples | application queries |
| Availability need | high for changes and visibility; **not** needed for applications to run | as high as the applications need |

**[DECIDED]** Invariants of the separation:

1. Applications never route through ExponetDB (C-1).
2. ExponetDB's outage stops *changes and visibility*, never *application
   traffic*.
3. A data-plane outage never stops ExponetDB from reporting it (C-5): the Control
   Store and the Control Plane processes do not run on a managed data-plane host.
4. The per-target ledger is the one piece of control information stored in the
   data plane, deliberately, so that history travels with the data
   ([ADR-0013](./adr/0013-in-target-ledger.md)).

## 2. Infrastructure: today and later

### 2.1 V1 topology

**[OBSERVED]** facts from REOSA's infrastructure documents (as of 2026-10-04,
`REOSA/reosa-docs/09-operations/self-hosting-04-database-and-auth.md` §3,
`self-hosting-00-stand.md` §4.10, `database-connections.md`):

| Item | Value | Status in REOSA docs |
|---|---|---|
| Private network range | `10.8.0.0/16` | as-built |
| Hetzner Cloud Network name | **`exponent`** | as-built (spelled with "n"; brand is "Exponet") |
| Cloud subnet | `10.8.1.0/24` (zone `eu-central`) | as-built |
| `reos-db-01` | `10.8.1.2` | **planned**, server not yet ordered |
| vSwitch subnet | `10.8.2.0/24`, gateway `10.8.2.1` | as-built |
| vSwitch | **`vSwitch-Exponent`**, ID 85953, VLAN 4000 | as-built |
| `reos-01` private address | `10.8.2.2/24` on `enp5s0.4000` | as-built 2026-10-04 |
| MTU | 1400 (1500 described as a silent `pg_restore` failure cause) | as-built |
| Auto-created subnet `10.8.0.0/24` | "can be deleted"; deletion not recorded | unknown |

**Discrepancies noted, not resolved here:**

- The brand is **Exponet** (`exponet.cloud`); the Hetzner objects are named
  `exponent` / `vSwitch-Exponent`. ExponetDB's documents use "Exponet network"
  for the concept and quote object names exactly. Renaming Hetzner objects is an
  infrastructure decision outside this documentation phase.
- The owner brief describes `reos-db-01` as Hetzner Cloud CX43 with 16 GB RAM;
  REOSA's handbook (HB4) says "8 GB RAM, at least 80 GB NVMe, x86" and states that
  the concrete SKU will be recorded at order time. **[DECIDED]** Nothing in
  ExponetDB depends on the host size; the registry records observed facts (CPU,
  memory, disk) reported by the node agent.
- REOSA's admin UI still labels the private address field "Adresse im Tunnel"
  with placeholder `10.8.0.1` (WireGuard leftovers). Not ExponetDB's concern; noted
  for REOSA.

V1 placement:

```
reos-01 (Hetzner dedicated EX44, FSN1; 10.8.2.2)        reos-db-01 (Hetzner Cloud, FSN1; 10.8.1.2) [planned]
├── Coolify + Traefik                                    ├── PostgreSQL 17 (PGDG) + pgvector, systemd
├── REOSA applications                                   │     reosa_production, reosa_staging
├── ExponetDB (serve, worker, gateway)                   └── exponetdb-node (+ helper)
└── ExponetDB Control Store (Coolify PostgreSQL)
        │                                                          ▲
        └──── private network 10.8.0.0/16, MTU 1400 ───────────────┘
              SQL: ExponetDB → 10.8.1.2:5432 (TLS verify-full)
              agent: exponetdb-node → 10.8.2.2:7443 (mTLS)
```

**[DECIDED]** for `reos-db-01` (consistent with REOSA's handbook): PostgreSQL 17
installed directly on the host from PGDG packages, pgvector from PGDG, managed by
systemd; no Docker, no Coolify, no Traefik for PostgreSQL; PostgreSQL listens on
the private address and loopback only.

### 2.2 Later topology

**[PLANNED]** (names may change; the domain model does not bind to names):

```
exponet-01      central Exponet services: ExponetDB (serve, worker, gateway), later the Exponet identity service
exponet-db-01   Control Store and other control-plane databases
reos-db-01      REOS/REOSA data plane
(more data-plane hosts as products need them)
```

The move changes deployment configuration (where processes run, where the Control
Store runs, the gateway address the agents dial), not the data model or the
external API. Node agents learn the new gateway address through a signed
configuration update job before the old gateway stops.

## 3. Network paths

**[DECIDED]**

| Path | From → To | Protocol | Authentication | Exposure |
|---|---|---|---|---|
| Users, agents, programs → ExponetDB | internet → Traefik on `reos-01` → `serve` | HTTPS | sessions, OAuth tokens, API keys | public (`db.exponet.cloud`) |
| ExponetDB → managed PostgreSQL | `worker`/`serve` → `10.8.1.2:5432` | PostgreSQL wire protocol over TLS (`verify-full`) | SCRAM per access role | private network only |
| Node agent → ExponetDB | `reos-db-01` → `10.8.2.2:7443` | HTTPS/2 with mutual TLS | client certificate issued at enrollment | private network only; not routed through Traefik |
| ExponetDB → Control Store | containers → Coolify DB on Docker network | PostgreSQL over the internal Docker network | SCRAM per process role | not published |
| Node agent → backup storage | `reos-db-01` → object storage | HTTPS | storage credentials held by the agent's backup engine configuration | outbound internet |
| REOSA apps → managed PostgreSQL | `reos-01` containers → `10.8.1.2:5432` | PostgreSQL over TLS | REOSA's own login roles | private network; **not** through ExponetDB |

**[DECIDED]** The gateway listens on the private network only in V1. A database
host outside the Exponet private network would need either a VPN/WireGuard link or
a public gateway endpoint with TLS passthrough; that is a later decision
([OD-18](../00-product/open-decisions.md#od-18-agent-gateway-exposure)).

## 4. Failure independence

| Failure | Data plane (applications) | Control plane (ExponetDB) | What ExponetDB reports |
|---|---|---|---|
| `reos-db-01` down | applications fail | keeps running | targets `unreachable`, node `offline` (two distinct facts), last good samples with timestamps |
| ExponetDB down | **unaffected** | down | nothing (REOSA's own direct probes keep working, see C-29) |
| Control Store down | unaffected | degraded (no auth, no operations) | `CONTROL_PLANE_DEGRADED` to clients |
| Private network partition | applications on `reos-01` lose the database too (same path) | cannot reach targets or receive agent heartbeats | targets `unreachable` **and** node `offline`; a partition looks identical to a host outage from `reos-01`; documented ambiguity, resolved by the node's own buffered heartbeats after recovery |
| Node agent down | unaffected | no host capabilities | node `offline`, targets still sampled over SQL (`healthy` if they are) |

## 5. Self-management boundary

**[DECIDED] V1:** ExponetDB does not manage its own infrastructure as targets. The
Control Store is bootstrap infrastructure
([`../02-control-plane/control-database.md` §6](../02-control-plane/control-database.md#6-self-management-boundary)).
ExponetDB's own container lifecycle belongs to Coolify. ExponetDB never restarts,
upgrades or reconfigures itself through its own operations.
