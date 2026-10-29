#!/usr/bin/env bash
# keys steps 6 and 7 (C1-7): serve process clock +2 h / -2 h / +2 min against the database clock (libfaketime on serve only).
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/kt1.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
ft() { echo "$2" >/srv/work/s6/ft-$1; sleep 1.5; }
T="$(add_target s6clkb pg16)"; dir="$(new_project s6clkb)"
mkb "$dir" clk-a <<<'CREATE TABLE public.clk_a (id int primary key);' >/dev/null
bearer
echo "DB clock vs serve (offset 0): $(ctl_sql 'select clock_timestamp()') | $(date -u +%T)"
echo "== A. serve +2 h: create a plan (standard class, default lifetime 30 min)"
ft serve +7200
mplan "$dir" "$T"; PA=$PLAN_ID
ft serve +0
echo "REST plan: $(rest GET /api/v1/plans/$PA | head -1 >/dev/null; jq -c '{createdAt,expiresAt,state}' /dev/shm/s6out.last)"
echo "DB: $(ctl_sql "select 'created_at='||created_at||' expires_at='||expires_at||' db_now='||clock_timestamp()||' expires_in='||(expires_at-clock_timestamp()) from operations.plans where plan_id='$PA'")"
EXP=$(ctl_sql "select extract(epoch from (expires_at - created_at)) from operations.plans where plan_id='$PA'"); echo "nominal lifetime: ${EXP}s"
DBEXP=$(ctl_sql "select extract(epoch from expires_at) from operations.plans where plan_id='$PA'")
echo "== B. serve -2 h: create a plan, apply it at once"
ft serve -7200
mkb "$dir" clk-b <<<'CREATE TABLE public.clk_b (id int primary key);' >/dev/null
mplan "$dir" "$T"; PB=$PLAN_ID; ft serve +0
echo "plan B in DB: $(ctl_sql "select 'created_at='||created_at||' expires_at='||expires_at||' db_now='||clock_timestamp()||' state='||state from operations.plans where plan_id='$PB'")"
mapply "$PB" --no-wait
echo "plan B state after apply attempt: $(ctl_sql "select state from operations.plans where plan_id='$PB'")"
echo "== C. nodes read offline on a serve ahead by 2 min"
echo "before: $(exdb_json node list | jq -c '[.data.items[]?|.state]')"
ft serve +120; sleep 3; echo "serve +120 s: $(exdb_json node list | jq -c '[.data.items[]?|.state]')"; ft serve +0; sleep 3; echo "after: $(exdb_json node list | jq -c '[.data.items[]?|.state]')"
ft serve -120; sleep 3; echo "serve -120 s: $(exdb_json node list | jq -c '[.data.items[]?|{state,lastHeartbeatAt}]')"; ft serve +0
echo "== D. audit of events written while serve ran +2 h: occurred_at is the database's"
ctl_sql "select seq, occurred_at, action from audit.audit_events order by seq desc limit 3"
echo "== E. plan A is applied when the DB clock passes its NOMINAL expiry (created+30 min of DB time): in $(echo "($DBEXP - $(date +%s)) / 60 - 118" | bc) min"
cat >$L6/kt1-late.sh <<EOT
. /srv/work/s6-infra/s6/lib6.sh
sleep \$(( $(date +%s) + 1860 - \$(date +%s) ))
bearer
echo "late apply of plan A (DB time ~31 min after creation, nominal lifetime 30 min) at \$(now)"
echo "plan A state: \$(ctl_sql "select state||' expires_at='||expires_at||' now='||clock_timestamp() from operations.plans where plan_id='$PA'")"
mapply $PA --no-wait
EOT
nohup bash $L6/kt1-late.sh >$L6/kt1-late.out 2>&1 < /dev/null &
echo "late-apply job started (log kt1-late.out)"
