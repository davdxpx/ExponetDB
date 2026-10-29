#!/usr/bin/env bash
# S4 task 1, step 3: node inspections (host secrets in settings/hba/backup config), then the role verifier flow.
source /srv/work/s4/env.sh
set -u
cd "$S4"
N=$(stack_id node); C17=$(stack_id cluster_pg17)
r() { s4ts s4/req.ts "$@" 2>&1 | tail -1; }
for cap in postgres.config.inspect@2 postgres.hba.inspect@2 postgres.roles.inspect@2 postgres.status@1 postgres.tls.inspect@1 backup.list@1 log.inspect@2 agent.diagnostics@2 packages.audit@1 cpu.stats@1 disk.stats@1 memory.stats@1; do
  printf '%-32s ' $cap
  exdb_json node inspect $N --capability $cap --cluster $C17 | jq -c '{state:(.data.state//.state), err:(.error.code//.data.errorCode//null)}' 2>/dev/null || echo failed
done
r obs-list GET /api/v1/nodes/$N/observations
r verifier-plan --reauth --wait --approve POST /api/v1/clusters/$C17/role-verifiers '{"role":"s4_canary_app","verifier":"@@C1-verifier@@"}'
psql_target pg17 -Atc "select rolname, rolpassword is not null from pg_authid where rolname='s4_canary_app'"
