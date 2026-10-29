#!/usr/bin/env bash
# "an expired thing must say expired, be listable and revocable": a plan aged by data (the DB clock cannot move): apply, the sweeper, list, withdraw.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/ka2.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
T="$(add_target s6exp pg16)"; dir="$(new_project s6exp)"
echo 'CREATE TABLE public.exp_a (id int primary key);' | mkb "$dir" exp-a >/dev/null
bearer; mplan "$dir" "$T"; P=$PLAN_ID
echo "before: $(ctl_sql "select state||' expires_in='||(expires_at-clock_timestamp()) from operations.plans where plan_id='$P'")"
psql_control -qAt -c "SET session_replication_role=replica; UPDATE operations.plans SET created_at=created_at-interval '3 hours', expires_at=expires_at-interval '3 hours' WHERE plan_id='$P'"
echo "aged: $(ctl_sql "select state||' expires_in='||(expires_at-clock_timestamp()) from operations.plans where plan_id='$P'") (sweeper has not run yet)"
echo "plan show: $(exdb_json plan show $P | jq -c '.data|{state,expiresAt}')"
echo "apply before the sweeper: $(exdb plan apply $P --yes --no-wait 2>&1 | tr '\n' ' ' | cut -c1-260)"
for i in $(seq 1 16); do s=$(ctl_sql "select state from operations.plans where plan_id='$P'"); [ "$s" = expired ] && break; sleep 5; done; echo "stored state after the sweeper: $s (waited $((i*5)) s)"
echo "plan show: $(exdb_json plan show $P | jq -c '.data|{state,expiresAt}')"
echo "plan list --state expired contains it: $(exdb_json plan list --state expired 2>/dev/null | jq -c '[.data.items[]?|.id] | index("'$P'") != null')"
echo "audit event: $(ctl_sql "select action||' '||occurred_at from audit.audit_events where plan_id='$P' order by seq desc limit 1")"
echo "withdraw the expired plan: $(exdb plan withdraw $P 2>&1 | tr '\n' ' ' | cut -c1-240)"
echo "apply after expiry: $(exdb plan apply $P --yes --no-wait 2>&1 | tr '\n' ' ' | cut -c1-260)"
