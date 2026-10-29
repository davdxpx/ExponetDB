#!/usr/bin/env bash
# observability step 8 (C1-2): worker killed with SIGKILL every ~25 s for 3 minutes; what do the health surfaces say?
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/obs-crash.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
bearer
snap() { echo "t=$(el) installation workers: $(bearer; rest GET /api/v1/installation/health | head -1 >/dev/null; jq -c '[.components[]|select((.id // .name)=="workers")|{state,reasons,values}]' /dev/shm/s6out.last | head -c 300) | serve ready=$(hc $S) detail workers: $(hdetail $S | jq -c '[.checks[]?|select(.name=="workers")|.status,.reason]') | live rows: $(ctl_sql "select count(*) from control.process_heartbeats where role='worker' and stopped_at is null and heartbeat_at > now() - interval '45 seconds'")"; }
t0; snap
for i in 1 2 3 4 5 6 7; do
  kill_role worker KILL >/dev/null 2>&1; sleep 3; snap; sleep 12; systemctl start $(_stk_unit worker); sleep 8; snap
done
echo "heartbeat rows started in the last 4 minutes (one per start): $(ctl_sql "select count(*) from control.process_heartbeats where role='worker' and started_at > now() - interval '4 minutes'")"
echo "worker metrics (reset by each start): $(curl -s http://$W/metrics | grep -c '^exdb_operations_loop_total') series; build_info: $(curl -s http://$W/metrics | grep '^exdb_build_info' | head -1)"
echo "log: process.starting count in 4 min: $(logs_since worker "-4 min" | grep -c process.starting)"
sleep 50; snap
