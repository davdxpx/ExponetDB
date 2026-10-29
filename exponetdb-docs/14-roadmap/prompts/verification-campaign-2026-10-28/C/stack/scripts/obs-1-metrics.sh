#!/usr/bin/env bash
# observability steps 1, 2, 15: metric inventory per role, route="/unmatched", scrape reachability
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/obs-1.out; : >$O
exec > >(tee -a $O) 2>&1
bearer
for i in 1 2 3 4 5 6 7 8 9 10; do for p in /api/v1/targets /api/v1/fleet /api/v1/nodes; do rest GET $p >/dev/null; done; done
echo "== step 2: serve exdb_http_requests_total (after 30 API calls)"
curl -s http://$S/metrics | grep '^exdb_http_requests_total'
echo "== step 1: TYPE lines per role"
for r in S W G; do eval p=\$$r; echo "-- $r $p"; curl -s http://$p/metrics | grep '^# TYPE' | awk '{print $3, $4}'; done
echo "== worker samples (names only)"
curl -s http://$W/metrics | grep -E '^(exdb_data_reads_total|exdb_operations_loop_total|exdb_maintenance_task_runs_total|exdb_audit_chain_verified)' | head -40
echo "== step 15: bind addresses"
ss -Hltn | grep -E ":5848[1-3]\b"
echo "== unauthenticated /metrics and /healthz/detail from an unrelated local process (loopback bind default?)"
curl -s -o /dev/null -w 'metrics http=%{http_code}\n' http://$S/metrics
curl -s -o /dev/null -w 'public /metrics http=%{http_code}\n' $API/metrics
curl -s -o /dev/null -w 'public /healthz/detail http=%{http_code}\n' $API/healthz/detail
curl -s -o /dev/null -w 'public /healthz/ready http=%{http_code}\n' $API/healthz/ready
echo "== env of the units: EXPONETDB_INTERNAL_LISTEN"
grep -rh INTERNAL_LISTEN ${EXSTACK_STATE}/env/ 2>/dev/null | sed 's/=.*:/=<addr>:/'
