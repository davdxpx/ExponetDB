source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
for db in lab_rhstg lab_rhscr lab_rhprod; do
  psql_target pg17 -d $db -X -q -c "grant usage on schema auth, storage, app_private to exponetdb_observer"
done
# reset the scratch target in place (the replay consumed it)
exdb_json migration import scratch-reset-sql --scratch lab/platform/rhscr | jq -r '.data.sql // .data.script // .data' > $L/scratch-reset.sql
psql_target pg17 -d lab_rhscr -X -q -v ON_ERROR_STOP=1 -f $L/scratch-reset.sql 2>&1 | grep -c NOTICE
$RH/run_analysis.sh rhstg rhscr a3 2>&1 | tail -4
R=$(ctl_sql "select report_id from migrations.import_reports where target_id='$(target_id lab/platform/rhstg)' order by created_at desc limit 1")
exdb_json migration import report $R --target lab/platform/rhstg > $L/report-rhstg.json
echo "report=$R"
jq -r ".data.items | group_by(.state) | map(\"\(.[0].state)=\(length)\") | join(\" \")" $L/report-rhstg.json
jq -r ".data | \"unresolved=\(.unresolved) drift=\(.driftTotal)\"" $L/report-rhstg.json
jq -r '.data.items[] | select(.decision==null and (.state|test("ambiguous|missing"))) | "\(.itemId) \(.state) \(.name) failing=\(.failing.total) \(.evidence|join(","))"' $L/report-rhstg.json
jq -r '.data.items[] | select(.itemId|tonumber>149) | "\(.itemId) \(.state) \(.name) \(.legacyId)"' $L/report-rhstg.json | head -30
