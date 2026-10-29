#!/usr/bin/env bash
# fail-closed step 11 (and observability step 3): no worker. Operations queue forever, readiness stays 200.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc11.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
T="$(add_target s6nw pg16)"; db=lab_s6nw
dir="$(new_project s6nw)"; id="$(mkb "$dir" nw <<<'CREATE TABLE public.nw_t (id int primary key);')"
mplan "$dir" "$T"
bearer
echo "== stop the worker $(now)"; t0
systemctl stop $(_stk_unit worker)
mapply "$PLAN_ID" --no-wait; op="$OP_ID"
for s in 5 30 55 80; do
  while [ "$(echo "$(el) < $s" | bc)" = 1 ]; do sleep 1; done
  echo "t=$(el): serve ready=$(hc $S) body=$(curl -s -m 3 http://$S/healthz/ready | head -c 60) public=$(curl -s -m 3 -o /dev/null -w '%{http_code}' $API/healthz/ready) op=[$(op_state $op)]"
done
echo "-- detail: $(hdetail $S | jq -c '[.status, (.checks[]|select(.status!="pass")|{name,status,reason})]')"
echo "-- gateway ready: $(hc $G); installation health: $(bearer; rest GET /api/v1/installation/health | head -1) $(jq -c '[.components[]|select(.state!="operational")|{id:(.id // .name // .component),state,reasons}]' /dev/shm/s6out.last | head -c 600)"
echo "-- docker-style health = readiness: serve stays healthy while operations are stuck: yes if 200 above"
echo "-- plan list for the plan: $(exdb_json plan show $PLAN_ID 2>/dev/null | jq -c '.data|{state}' 2>/dev/null)"
echo "== start the worker $(now)"; t0; systemctl start $(_stk_unit worker)
last=""; for i in $(seq 1 90); do cur="$(op_state $op)"; [ "$cur" != "$last" ] && { echo "  t=$(el) $cur"; last="$cur"; }; case "${cur%% *}" in succeeded|failed|needs_attention) break;; esac; sleep 2; done
