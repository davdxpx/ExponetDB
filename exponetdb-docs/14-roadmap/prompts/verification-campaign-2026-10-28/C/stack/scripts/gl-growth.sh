#!/usr/bin/env bash
# graceful-life step 8: synthetic growth. Rows are cloned from real ones (plans, bodies, operations, one event each, audit events) with the
# triggers off (session_replication_role=replica). The audit rows do NOT form a valid hash chain: run this last. Measures the list
# endpoints before/after and the table sizes. N_OPS (default 1,000,000), N_AUD (default 5,000,000).
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/gl-growth.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
N_OPS=${N_OPS:-1000000}; N_AUD=${N_AUD:-5000000}
sz() { ctl_sql "select string_agg(t||'='||pg_size_pretty(pg_total_relation_size(t)), ' ') from (values ('operations.operations'),('operations.plans'),('operations.plan_bodies'),('operations.operation_events'),('audit.audit_events')) v(t)"; }
rows() { ctl_sql "select (select count(*) from operations.operations)||' operations, '||(select count(*) from audit.audit_events)||' audit events'"; }
timeit() { # label path
  local best=999 t i
  for i in 1 2 3; do t=$(curl -s -o /dev/null -m 120 -w '%{time_total}' -H @$HDR "$API$2"); best=$(echo "if ($t < $best) $t else $best" | bc -l); done
  printf '   %-48s best of 3: %.3f s\n' "$1" "$best"
}
measure() {
  bearer
  timeit "GET /operations?limit=50" "/api/v1/operations?limit=50"
  timeit "GET /operations?state=queued&limit=50" "/api/v1/operations?state=queued&limit=50"
  timeit "GET /plans?limit=50" "/api/v1/plans?limit=50"
  timeit "GET /approvals" "/api/v1/approvals"
  timeit "GET /fleet" "/api/v1/fleet"
  timeit "GET /audit-events?limit=50" "/api/v1/audit-events?limit=50"
  timeit "GET /audit-events/chain" "/api/v1/audit-events/chain"
  timeit "GET /installation/health" "/api/v1/installation/health"
  timeit "GET /targets" "/api/v1/targets"
}
echo "== before: $(rows); sizes: $(sz)"; measure
echo "== insert $N_OPS operations (plan + body + operation + 1 event each) $(now)"
t0=$(date +%s)
psql_control -v ON_ERROR_STOP=1 -q <<SQL 2>&1 | head -5
SET session_replication_role = replica;
SET synchronous_commit = off;
CREATE TEMP TABLE tp AS SELECT * FROM operations.plans WHERE kind='registry.product.create' LIMIT 1;
CREATE TEMP TABLE tb AS SELECT b.* FROM operations.plan_bodies b JOIN tp USING (plan_id);
CREATE TEMP TABLE tops AS SELECT o.* FROM operations.operations o JOIN tp USING (plan_id) LIMIT 1;
INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash, content_checksum, policy_version, actor_kind, actor_id, client_kind, client_id, target_id, tier, created_at, expires_at, state_changed_at)
  SELECT 'pln_0' || lpad(g::text, 25, '0'), kind, kind_version, action_class, 'consumed', decision, 'sha256:' || encode(sha256(g::text::bytea), 'hex'), content_checksum, policy_version, actor_kind, actor_id, client_kind, client_id, target_id, tier,
         now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval + interval '5 minutes', now() - (g || ' seconds')::interval FROM tp, generate_series(1, $N_OPS) g;
INSERT INTO operations.plan_bodies (plan_id, body) SELECT 'pln_0' || lpad(g::text, 25, '0'), body FROM tb, generate_series(1, $N_OPS) g;
INSERT INTO operations.operations (operation_id, plan_id, kind, kind_version, state, apply_outcome, verification_outcome, actor_kind, actor_id, client_kind, client_id, lease_owner, lease_expires_at, attempt, created_at, updated_at)
  SELECT 'op_0' || lpad(g::text, 25, '0'), 'pln_0' || lpad(g::text, 25, '0'), kind, kind_version, 'succeeded', 'applied', 'passed', actor_kind, actor_id, client_kind, client_id, NULL, NULL, attempt, now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval FROM tops, generate_series(1, $N_OPS) g;
INSERT INTO operations.operation_events (operation_id, at, kind, from_state, to_state, actor, detail)
  SELECT 'op_0' || lpad(g::text, 25, '0'), now() - (g || ' seconds')::interval, 'created', NULL, 'queued', NULL, '{}'::jsonb FROM generate_series(1, $N_OPS) g;
ANALYZE operations.operations; ANALYZE operations.plans; ANALYZE operations.plan_bodies; ANALYZE operations.operation_events;
SQL
echo "inserted in $(( $(date +%s) - t0 )) s: $(rows)"
echo "== insert $N_AUD audit events $(now)"; t0=$(date +%s)
psql_control -v ON_ERROR_STOP=1 -q <<SQL 2>&1 | head -5
SET session_replication_role = replica;
SET synchronous_commit = off;
CREATE TEMP TABLE ta AS SELECT * FROM audit.audit_events ORDER BY seq DESC LIMIT 1;
INSERT INTO audit.audit_events (occurred_at, event_id, action, phase, actor_kind, actor_id, operation_id, plan_id, event, prev_hash, hash)
  SELECT now() + (g || ' milliseconds')::interval, 'aud_0' || lpad(g::text, 25, '0'), action, phase, actor_kind, actor_id, NULL, NULL, event, prev_hash, 'sha256:ac1:' || encode(sha256(g::text::bytea), 'hex') FROM ta, generate_series(1, $N_AUD) g;
ANALYZE audit.audit_events;
SQL
echo "inserted in $(( $(date +%s) - t0 )) s: $(rows)"
echo "== after: sizes: $(sz)"; measure
echo "== full scan floor for the daily chain verification: select count(*), sum(length(event)) over the audit table"
t0=$(date +%s.%N); ctl_sql "select count(*), sum(length(event)+length(hash)) from audit.audit_events" | tr '\n' ' '; echo "  scan $(printf '%.1f' $(echo "$(date +%s.%N)-$t0" | bc)) s"
echo "worker: audit.verify_* after the insert: $(ctl_sql "select task||'='||coalesce(last_outcome,'-') from control.maintenance_tasks where task like 'audit.verify%'" | tr '\n' ' ')"
echo "== vacuum/bloat: n_dead_tup observation.findings $(ctl_sql "select n_dead_tup from pg_stat_user_tables where relname='findings'")"
