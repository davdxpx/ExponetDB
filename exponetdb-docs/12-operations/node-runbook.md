# Node agent: host installation, enrollment and RB-13

| | |
|---|---|
| Status | **[DECIDED]** Wave 5 Phase 6 (2026-10-07); the steps are those the host test runs ([`../../apps/server/test/agent-capabilities.host.test.ts`](../../apps/server/test/agent-capabilities.host.test.ts)); a run on a real installation is owner evidence for G5 |
| Applies to | Ubuntu 24.04 database hosts with PostgreSQL 16, 17 or 18 in the Debian packaging layout |
| Read before | [`../07-node-agent/architecture.md`](../07-node-agent/architecture.md), [`../07-node-agent/enrollment.md`](../07-node-agent/enrollment.md), [`../07-node-agent/security.md`](../07-node-agent/security.md), [`../07-node-agent/control-plane.md`](../07-node-agent/control-plane.md) |

A database host runs two binaries and nothing else of ExponetDB: the
unprivileged agent `exponetdb-node` and the root helper
`exponetdb-node-helper`, started by systemd. No Docker, Node.js or Bun on the
host. Never install them on a host whose PostgreSQL another tool manages.

## 1. Before you start

- The Control Plane's agent PKI exists (`exponetdb node-pki init`,
  [`deployment.md`](./deployment.md)); you have its root fingerprint and the
  first job key's fingerprint (`nodes.job_keys`, shown by the ceremony).
- If ExponetDB will issue the PostgreSQL server certificates: the PostgreSQL
  CA exists (`exponetdb node-pki postgres-ca`) and its certificate is in the
  CA bundle you register the cluster with. The bundle never changes later
  (control-plane.md §9.5).
- The host's clock is synchronized (`timedatectl` shows
  `System clock synchronized: yes`): the agent and the helper refuse every
  job while the kernel reports an unsynchronized clock or a maximum error of
  16 s or more.
- The host reaches the gateway's private listener (`EXPONETDB_GATEWAY_LISTEN`,
  OD-18); nothing else needs to reach the host.

## 2. Install

As root on the host:

1. Check the release against its checksums, then install:

   ```sh
   sha256sum -c SHA256SUMS-<version> --ignore-missing
   install -m 0755 exponetdb-node-<version>-linux-amd64 /usr/bin/exponetdb-node
   install -m 0755 exponetdb-node-helper-<version>-linux-amd64 /usr/sbin/exponetdb-node-helper
   install -m 0644 sysusers.d/exponetdb-node.conf /usr/lib/sysusers.d/
   systemd-sysusers
   install -m 0644 systemd/exponetdb-node.service systemd/exponetdb-node-helper.service \
     systemd/exponetdb-node-helper.socket /etc/systemd/system/
   install -D -m 0644 doc/node-runbook.md /usr/share/doc/exponetdb-node/node-runbook.md
   systemctl daemon-reload
   ```

   The release directory holds the binaries, `systemd/`, `sysusers.d/`,
   `doc/` and `SHA256SUMS-<version>` over all of them
   ([`agent/node/packaging/README.md`](../../agent/node/packaging/README.md)).
   `exponetdb-node version` prints the version and the commit it was built
   from.

2. PostgreSQL, for each cluster the agent manages (as `postgres`):

   ```sql
   CREATE ROLE exponetdb_node SUPERUSER LOGIN;   -- local socket only, see pg_hba below
   ```

   In `/etc/postgresql/<major>/<cluster>/pg_ident.conf`:
   `exponetdb exponetdb-node exponetdb_node`; as the **first** line of
   `pg_hba.conf`: `local all exponetdb_node peer map=exponetdb`. No `host`
   rule may name `exponetdb_node`. Keep `include_dir = 'conf.d'` in
   `postgresql.conf` (the Debian default): it is the managed include of
   OD-20, and configuration changes are refused without it. Reload
   PostgreSQL.

3. The operator configuration `/etc/exponetdb-node/config.json`, owned by
   root, mode `0644` (the agent refuses a configuration anyone else can
   write):

   ```json
   {
     "schema": "exponetdb.node-config/v1",
     "stateDirectory": "/var/lib/exponetdb-node",
     "helperSocket": "/run/exponetdb-node/helper.sock",
     "agentUser": "exponetdb-node",
     "disabledCapabilities": [],
     "instances": [
       {
         "localName": "17/main",
         "unit": "postgresql@17-main.service",
         "port": 5432,
         "socketDirectory": "/var/run/postgresql",
         "dataDirectory": "/var/lib/postgresql/17/main",
         "configFile": "/etc/postgresql/17/main/postgresql.conf",
         "hbaFile": "/etc/postgresql/17/main/pg_hba.conf",
         "managedInclude": "/etc/postgresql/17/main/conf.d/90-exponetdb.conf",
         "tlsCertificateFile": "/etc/postgresql/17/main/server.crt",
         "tlsKeyFile": "/etc/postgresql/17/main/server.key"
       }
     ]
   }
   ```

   The TLS files are dedicated to the instance (never the shared snakeoil
   pair) and lie under `/etc/postgresql`, where the helper may write. A
   capability listed in `disabledCapabilities` is answered
   `CAPABILITY_UNAVAILABLE` (for example `packages.plan_update` on a host
   whose packages another process manages). `restartIntervalSeconds`
   (optional, 600 when unset) is the least time between two PostgreSQL
   restarts the helper performs: a restart asked for sooner is refused
   before anything happens on the host, whoever signed it (its operation
   ends `not_applied` after the restart's settle time, about 11 minutes).

## 3. Register and enroll

1. In the Control Plane (Web App or REST, `registry.manage`, with
   re-authentication): the server, then the cluster with
   `management_mode = agent` on that server, confirmed with its
   `system_identifier`; an endpoint for ExponetDB's own logins.
2. Plan `node.enroll` for the server and apply it (re-authentication); then
   reveal the token in the Web App (the identity that applied the plan,
   within 30 minutes, once). Copy it to the host into a file of mode `0600`,
   never onto a command line.
3. Enroll as the agent's user, then remove the file:

   ```sh
   sudo -u exponetdb-node exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file /root/token
   shred -u /root/token
   ```

   The command prints the node id. The token pins the agent PKI's root and
   the job keys; a token for another installation, an expired or a used
   token is refused. **[DECIDED]** (review finding F7) Enrollment first
   creates the agent's replay files, `journal/journal.log` and
   `journal/nonces.log` in the state directory, durably; from then on a
   missing one is lost replay state, never recreated (§7).
4. Give the helper its own copy of the trusted job keys, naming the
   fingerprint you expect:

   ```sh
   exponetdb-node-helper trust --agent-state /var/lib/exponetdb-node --expect-key sha256:<job key fingerprint>
   ```

5. Start:

   ```sh
   systemctl enable --now exponetdb-node-helper.socket exponetdb-node.service
   ```

   The helper's first start creates its effect ledger
   (`/var/lib/exponetdb-node-helper/effects.log`) and records that in
   `/etc/exponetdb-node/helper-ledger.json`; from then on a missing ledger
   is lost, never recreated (§7).

## 4. Verify

- `GET /api/v1/nodes/{nodeId}` reads `active` (after the worker bound the
  node) with a heartbeat younger than a minute.
- `POST /api/v1/nodes/{nodeId}/inspections` with
  `{"capability": "postgres.status@1", "clusterId": "cls_…", "args": {}}`
  ends `succeeded`, and `GET /api/v1/nodes/{nodeId}/observations` shows the
  result with source `agent_reported`. A `REGISTRY_CONFLICT`
  `cluster_unmapped` means the instance's system identifier differs from the
  registered one, or the instance is missing from `config.json`.
- On the host: `systemctl status exponetdb-node exponetdb-node-helper.socket`,
  `exponetdb-node status` (node, gateway, certificate expiry, journal).

## 5. Rotating the job-signing key

The worker signs every job with the installation's active job key; each node
trusts at most three keys. A rotation never leaves a node unable to verify
a job ([`control-plane.md` §9.8](../07-node-agent/control-plane.md#98-job-key-rotation-nodeconfigupdate)).
Run the `node-pki` commands in the worker container (login `exdb_worker`,
the keyring in the environment); each step is audited (`node_pki.*`).

1. `exponetdb node-pki job-key stage`: prints the new key id. New enrollment
   tokens anchor it from now on.
2. For every live node: `POST /api/v1/nodes/{nodeId}/config-updates` with
   `{"addJobKeys": ["<new key>"], "retireJobKeys": []}`, then apply the plan
   (re-authentication). It ends `succeeded` and verified when a read signed
   with the new key was accepted.
3. `exponetdb node-pki job-key activate`: refused with `job_key_not_trusted`
   while a live node or an open enrollment token lacks the new key (update
   the node, or let the token expire); otherwise the old key turns
   `retiring` and never signs again.
4. After 7 days (`job_key_overlap` before): for every live node,
   `POST /api/v1/nodes/{nodeId}/config-updates` with
   `{"addJobKeys": [], "retireJobKeys": ["<old key>"]}`, then apply.
5. `exponetdb node-pki job-key retire <old key>`: refused with
   `job_key_still_trusted` while a live node still trusts it or an
   enrollment token that can still be revealed or redeemed anchors it. A
   retired key is never anchored or used again.

`exponetdb node-pki job-key list` shows each key's state. An offline node
still counts as live: activation and retirement wait for it. Update it when
it is back, or decommission it and enroll it again (§3). If an update ended
open (the helper's keys changed, the agent's not), plan the same change
again: it completes on the host. A stolen
signing key is recovered from only by enrolling every node again with new
tokens (ADR-0024 §1).

## 6. RB-13 Node agent lost

| | |
|---|---|
| Trigger | the node reads `offline` (no heartbeat for 60 s) for more than 15 minutes |
| Severity | S2 if the node serves production clusters, else S3 |

**Checks** (via SSH, read-only first):

1. `systemctl status exponetdb-node exponetdb-node-helper.socket` and
   `journalctl -u exponetdb-node -u exponetdb-node-helper --since -1h`.
2. `sudo -u exponetdb-node exponetdb-node status`: the certificate's expiry
   (72 hours; the agent renews at two thirds), the journal (`journal_corrupt`
   refuses every job).
3. `timedatectl`: an unsynchronized clock makes the agent refuse every job
   (`clock_untrusted`), not go offline; an offline node is a process,
   network or certificate problem.
4. The node's state in the Control Plane: a `revoked` node is refused by
   the gateway on purpose.
5. The network path to the gateway's private listener.

**Actions:**

- Process stopped or crashed: `systemctl restart exponetdb-node`. It
  reports jobs that were running when it stopped as `interrupted`; it never
  resumes them.
- Certificate expired (the node was down for more than 72 hours): the node
  cannot renew; decommission it (`node.decommission`, re-authentication),
  move `/var/lib/exponetdb-node` aside, and enroll again (§3) with a new
  token. The old node id is never reused.
- Journal corrupt: keep the state directory for analysis, decommission and
  enroll again. Journal or nonce cache missing, or the helper's effect
  ledger lost: §7.

**What happens to work meanwhile:** jobs nobody claimed expire with their
window (15 minutes for changes, 5 for reads); their operations fail
`JOB_EXPIRED` and nothing runs later. A job that was running turns
`outcome_unknown`; its operation is reconciled from the host when the node
returns (a late statement, or a fresh read), never run again. Plans made
before the outage bind the node and its observation; plan again.

**Verify:** the node reads `active` with a fresh heartbeat and an
inspection succeeds (§4).

**Follow-up:** an incident record with the cause; a recurring cause gets a
finding or a policy ([`incident-model.md` §5](./incident-model.md#5-after-an-incident)).

## 7. Replay state missing

**[DECIDED]** (review finding F7, 2026-10-08;
[`architecture.md` §4](../07-node-agent/architecture.md#4-local-state) and
§2 item 5). The agent's journal and nonce cache and the helper's effect
ledger are what keep a signed job from running twice. Each is created
once, at enrollment (the agent) or at the helper's first start, and is
never recreated on its own: a missing file after that is lost replay
state, and the process fails closed.

**What you see**

- Agent: the log line "replay state missing: the node is enrolled, so its
  journal or nonce cache was lost; every job is refused"; every job ends
  `journal_corrupt` (its operation proves that nothing ran and fails
  `not_applied`); the error is in the node's heartbeats (`lastErrors`).
  `sudo -u exponetdb-node exponetdb-node status` prints `journal missing`.
- Helper: `journalctl -u exponetdb-node-helper` shows "the effect ledger is
  lost: … every effect is refused, nothing is recreated". Reads (status,
  diagnostics, package audits) still work; every change (restart,
  configuration, `pg_hba`, TLS, trust update) is refused `failed`.
- A statement the agent stored but can no longer account for (its journal
  says it was stored, the buffer no longer has it) is reported as an
  "anomaly" in heartbeats; it is never signed again.

**Actions**

1. Do not create, empty, copy over or delete a replay file, and do not
   delete files in `buffer/` (a `*.refused` file is a parked statement:
   evidence the gateway refused). Keep the state directories for analysis.
2. A node **enrolled by the previous release that never started** has no
   replay files and nothing to lose. With the agent stopped:

   ```sh
   sudo -u exponetdb-node exponetdb-node journal init --config /etc/exponetdb-node/config.json
   ```

   It refuses, and changes nothing, when either file exists, when the host
   is not enrolled, or when the node's state records an accepted job; then
   go to step 3.
3. **Every other agent case** (the node ran a job): the replay state is
   lost and the node cannot prove which envelopes it already ran.
   Decommission the node (`node.decommission`), move
   `/var/lib/exponetdb-node` aside, enroll the host again (§3) with a new
   token and give the helper the new node's trust (§3 step 4). Jobs signed
   for the old node are then refused by node id.
4. **Helper ledger lost.** If the helper never performed an effect (its
   state directory was recreated before the first job), or after step 3
   (the trust names the new node), with the helper stopped:

   ```sh
   exponetdb-node-helper ledger init
   ```

   (add `--state-dir` and `--trust` if the unit passes them to `serve`). It
   refuses, and changes nothing, when the ledger exists. Otherwise do
   step 3 first.

**Upgrade and downgrade.** Upgrading from the previous release needs no
step for a node that ran a job (its replay files exist; a job it had
stored but not journaled is settled at the first start) or for the helper
(a ledger without its record gets one at the first start; a helper that
never served creates its ledger then). A node enrolled by the previous
release that never started needs step 2. From the first job on, the
journal is in format 2: an older agent refuses every job with
`journal_corrupt`, so a downgrade means enrolling the host again (step 3).

**Verify:** `exponetdb-node status` prints the journal's jobs, the
helper's log has no "lost" line, and an inspection succeeds (§4).
