cd /srv/work/s3-infra/s3 && . ./lib.sh && s3_release new
PEND="$(ls -t /srv/work/s3/logs/state/plan-pending-*.id | head -1)"; PP="$(cat $PEND)"; AP_OP="$(cat /srv/work/s3/logs/state/op-awaiting-approval.id)"; NA_OP="$(cat /srv/work/s3/logs/state/op-needs-attention.id)"
echo "now $(date -u +%T)"
echo "=== D. the pending plan $PP (old release, created 20:00) after the upgrade"
echo "plan state in store: $(ctl_sql "select state||' expires='||expires_at from operations.plans where plan_id='$PP'")"
exdb plan show "$PP" 2>&1 | head -14
echo "--- apply (CLI text)"; exdb plan apply "$PP" --no-wait --yes 2>&1 | head -14; echo "rc=$?"
echo "--- apply (CLI json)"; exdb_json plan apply "$PP" --no-wait --yes | jq -c '{status, error, http: .httpStatus}' | cut -c1-600
echo "plan state after: $(ctl_sql "select state from operations.plans where plan_id='$PP'")"; echo "operations created for it: $(ctl_sql "select count(*) from operations.operations where plan_id='$PP'")"
echo "serve log lines about it:"; journal serve --since "-3 min" | grep -iE "$PP|plan_stale|operation_kind_unknown|error" | cut -c1-400 | head -8
echo "=== E. the awaiting_approval operation $AP_OP"
op_state "$AP_OP"; exdb operation show "$AP_OP" 2>&1 | head -22
echo "=== F. the needs_attention operation $NA_OP"
op_state "$NA_OP"; echo "locks: $(ctl_sql "select string_agg(domain_key, ',') from operations.operation_locks where operation_id='$NA_OP'")"
exdb operation show "$NA_OP" 2>&1 | sed -n 1,24p
