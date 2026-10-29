#!/usr/bin/env bash
# S4 task 1, step 4: run the flows that touch the canaries (migration, drift, queries, reads, exports) and the failure paths.
source /srv/work/s4/env.sh
set -u
cd "$S4"
T16=lab/platform/dev16; ID16=$(stack_id target_dev16); mkdir -p $L4/cli $L4/api
r() { s4ts s4/req.ts "$@" 2>&1 | tail -1; }
save() { n=$1; shift; mkdir -p $L4/cli; ( "$@" ) >$L4/cli/$n.txt 2>&1; echo "$n rc=$?"; }
PLAN=$(ls -t $L4/api/*-op.json >/dev/null 2>&1; echo none)
for c in "schema overview" "schema fingerprint" "diagnose query-stats" "diagnose table-stats" "diagnose advisors" "session list" "finding list" "finding summary"; do
  n=$(echo $c | tr ' ' '-'); case "$c" in "finding"*) save $n exdb $c --output json;; *) save $n exdb $c $T16 --output json;; esac
done
r query-dev16 POST /api/v1/targets/$ID16/queries '{"sql":"select id, note from public.s4_rows"}'
r query-bad-sql POST /api/v1/targets/$ID16/queries '{"sql":"select * from public.no_such_table_s4"}'
r explain-dev16 POST /api/v1/targets/$ID16/explain '{"sql":"select * from public.s4_rows"}'
echo "== audit, plan and operation exports"
save audit-list exdb audit list --limit 500 --output json
r audit-export GET "/api/v1/audit-events/export"
r audit-chain GET "/api/v1/audit-events/chain"
PL=$(jq -r .planId $L4/cli/mplan.txt 2>/dev/null); PLAN=$(sed -n 's/^plan=\([^ ]*\).*/\1/p' $L4/cli/mplan.txt)
save operation-list exdb operation list --output json
echo "== failure: wrong password at query time (the stored credential no longer matches the database)"
python3 $S4/scram.py C2-wrong-password | { read -r v; psql_target pg16 -q <<<"ALTER ROLE exponetdb_reader PASSWORD '$v'"; }
sleep 1
r query-wrongpw POST /api/v1/targets/$ID16/queries '{"sql":"select 1"}'
r query-wrongpw2 POST /api/v1/targets/$ID16/queries '{"sql":"select 1"}'
save schema-wrongpw exdb schema overview $T16 --output json
python3 $S4/scram.py C2-reader-password | { read -r v; psql_target pg16 -q <<<"ALTER ROLE exponetdb_reader PASSWORD '$v'"; }
echo "== failure: target unreachable"
net_block 55416 reject
r query-unreach POST /api/v1/targets/$ID16/queries '{"sql":"select 1"}'
save drift-unreach exdb drift check $T16 --output json
save health-unreach exdb health $T16 --output json
net_unblock
echo "== failure: TLS (server stops offering TLS)"
echo "ssl = off" > /etc/postgresql/16/exdbnode/conf.d/60-s4-ssloff.conf; systemctl reload postgresql@16-exdbnode.service; sleep 1
r query-tlsoff POST /api/v1/targets/$ID16/queries '{"sql":"select 1"}'
save drift-tlsoff exdb drift check $T16 --output json
rm -f /etc/postgresql/16/exdbnode/conf.d/60-s4-ssloff.conf; systemctl reload postgresql@16-exdbnode.service
echo "== node, credentials, backups"
save node-show exdb node show $(stack_id node) --output json
save node-observations exdb node observations $(stack_id node) --output json
save cluster-credentials exdb cluster credentials $(stack_id cluster_pg16) --output json
save backup-overview exdb backup overview --output json
save backup-policy exdb backup policy show $(stack_id cluster_pg17) --output json
save backup-repos exdb backup repositories $(stack_id cluster_pg17) --output json
echo "== API key: use, wrong key, revoked key"
K=$(cat $S4/creds/service-account.token)
curl -s -o $L4/api/apikey-targets.json -w 'apikey GET targets %{http_code}\n' -H "Authorization: Bearer $K" http://127.0.0.1:58480/api/v1/targets
curl -s -o $L4/api/apikey-wrong.json -w 'wrong key %{http_code}\n' -H "Authorization: Bearer ${K%?}x" http://127.0.0.1:58480/api/v1/targets
curl -s -o $L4/api/apikey-malformed.json -w 'malformed bearer %{http_code}\n' -H "Authorization: Bearer ${K}${K}" http://127.0.0.1:58480/api/v1/targets
curl -s -o $L4/api/apikey-query.json -w 'apikey POST query %{http_code}\n' -H "Authorization: Bearer $K" -H 'content-type: application/json' -d '{"sql":"select 1"}' http://127.0.0.1:58480/api/v1/targets/$ID16/queries
