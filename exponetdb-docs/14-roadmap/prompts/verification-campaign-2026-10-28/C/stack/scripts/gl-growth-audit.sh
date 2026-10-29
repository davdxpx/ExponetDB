#!/usr/bin/env bash
# second pass of gl-growth.sh: 5,000,000 synthetic audit rows (explicit seq; hashes are NOT a valid chain), then the audit endpoints and
# the cost of reading the whole chain.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/gl-growth-audit.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
N_AUD=${N_AUD:-5000000}
timeit() { local best=999 t i; for i in 1 2 3; do t=$(curl -s -o /dev/null -m 120 -w '%{time_total}' -H @$HDR "$API$2"); best=$(echo "if ($t < $best) $t else $best" | bc -l); done; printf '   %-40s best of 3: %.3f s\n' "$1" "$best"; }
bearer
BASE=$(ctl_sql "select max(seq) from audit.audit_events"); echo "base seq $BASE; inserting $N_AUD $(now)"; t0=$(date +%s)
psql_control -v ON_ERROR_STOP=1 -q <<SQL 2>&1 | head -4
SET session_replication_role = replica;
SET synchronous_commit = off;
CREATE TEMP TABLE ta AS SELECT * FROM audit.audit_events ORDER BY seq DESC LIMIT 1;
INSERT INTO audit.audit_events (seq, occurred_at, event_id, action, phase, actor_kind, actor_id, operation_id, plan_id, event, prev_hash, hash)
  SELECT $BASE + g, ta.occurred_at + (g || ' milliseconds')::interval, 'aud_1' || lpad(g::text, 25, '0'), action, phase, actor_kind, actor_id, NULL, NULL, event, prev_hash, 'sha256:ac1:' || encode(sha256(g::text::bytea), 'hex') FROM ta, generate_series(1, $N_AUD) g;
ANALYZE audit.audit_events;
SQL
echo "inserted in $(( $(date +%s) - t0 )) s: $(ctl_sql 'select count(*) from audit.audit_events') audit events"
echo "partition sizes: $(ctl_sql "select string_agg(relname||'='||pg_size_pretty(pg_total_relation_size(c.oid)), ' ') from pg_class c join pg_namespace n on n.oid=relnamespace where n.nspname='audit' and relname like 'audit_events_y%'")"
timeit "GET /audit-events?limit=50" "/api/v1/audit-events?limit=50"
timeit "GET /audit-events/chain" "/api/v1/audit-events/chain"
timeit "GET /installation/health" "/api/v1/installation/health"
timeit "GET /fleet" "/api/v1/fleet"
echo "== reading the whole chain (the daily full verification does at least this): count, length and a sha256 per row"
t0=$(date +%s.%N); ctl_sql "select count(*), sum(length(encode(sha256(event::bytea),'hex'))) from audit.audit_events" | tr '\n' ' '; echo "  $(printf '%.1f' $(echo "$(date +%s.%N)-$t0" | bc)) s for $(ctl_sql 'select count(*) from audit.audit_events') rows"
echo "== audit verify (stops at the first bad hash, so this only times the start)"; t0=$(date +%s.%N); ro audit verify 2>&1 | tail -4 | tr '\n' ' ' | cut -c1-300; echo "  $(printf '%.1f' $(echo "$(date +%s.%N)-$t0" | bc)) s"
echo "worker task: $(ctl_sql "select task||'='||coalesce(last_outcome,'-')||'/'||coalesce(last_reason,'-') from control.maintenance_tasks where task like 'audit.verify%'" | tr '\n' ' ')"
