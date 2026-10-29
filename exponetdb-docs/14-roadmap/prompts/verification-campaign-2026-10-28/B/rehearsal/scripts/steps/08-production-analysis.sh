source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
reset_scratch() { exdb_json migration import scratch-reset-sql --scratch lab/platform/rhscr | jq -r '.data.sql // .data.script // .data' > $L/scratch-reset.sql; psql_target pg17 -d lab_rhscr -X -q -v ON_ERROR_STOP=1 -f $L/scratch-reset.sql >/dev/null 2>&1; }
true
exdb migration import scratch-check --target lab/platform/rhprod --scratch lab/platform/rhscr 2>&1 | sed -n 3,5p
EXTRA=--yes $RH/run_analysis.sh rhprod rhscr prod1 2>&1 | tail -4
R=$(ctl_sql "select report_id from migrations.import_reports where target_id='$(target_id lab/platform/rhprod)' order by created_at desc limit 1")
echo "report=$R"; echo $R > $L/report-id-rhprod
./../../rehearsal/resolve_all.sh $R rhprod 2>&1 | tail -3
