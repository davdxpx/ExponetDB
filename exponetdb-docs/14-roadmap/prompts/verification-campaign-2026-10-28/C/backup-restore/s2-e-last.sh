# Phase E2: damage to the NEWEST archived segment when it holds committed data (archive_timeout=0 so that no later segment appears)
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/e2-last.log) 2>&1
mode owned; bind
burst() { marker_up; sleep 12; marker_down; archive_catchup; FINAL=$(tail -1 $MARKLOG | cut -d'|' -f1); echo "burst done: final marker id $FINAL; newest segment $(find /var/lib/pgbackrest/archive/exdbnode/17-1 -type f ! -name '*.backup' | sed 's#.*/##' | sort | tail -1 | cut -c1-24)"; }
runuser -u postgres -- psql -X -q -p 55417 -d postgres -c "ALTER SYSTEM SET archive_timeout = 0" -c "SELECT pg_reload_conf()" >/dev/null
srcref_make >/dev/null
verify_all() { local R=$(rid) T0=$(ts); c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":null,\"snapshot\":null}" >/dev/null; local o=$(wait_run $R 1800); echo "  helper backup.verify (whole repo): state=$(echo "$o"|jq -r .result.state) verifyErrors=$(echo "$o"|jq -r .result.outcome.verifyErrors) in $(echo "$(ts) - $T0"|bc)s"; }
for CASE in "$@"; do
  burst
  echo "=================== CASE $CASE ($(date -u +%T))"
  bash /srv/work/s2/scripts/s2-inject.sh $CASE apply
  verify_all
  RESTORE_STATE=not-started; restore_run "fail-$CASE" '{"label":null,"time":null,"lsn":null,"timeline":null}' ""
  echo "  restore state=$RESTORE_STATE"
  if [ "$RESTORE_STATE" = succeeded ]; then S=$SCR/$RESTORE_RUN; scratch_up $RESTORE_RUN $RESTORE_PORT && { echo "  restored marker rows: $(psql_s $S $RESTORE_PORT "SELECT count(*)||' (max id '||coalesce(max(id),0)||')' FROM marker") vs source final $FINAL  => $(( FINAL - $(psql_s $S $RESTORE_PORT "SELECT coalesce(max(id),0) FROM marker") )) committed rows missing"; scratch_down $RESTORE_RUN; }; fi
  restore_discard $RESTORE_RUN
  bash /srv/work/s2/scripts/s2-inject.sh $CASE revert
done
burst
echo "state left for the Control Plane cases: archive_timeout=0, newest segment holds committed rows, final marker $FINAL"
echo E2-DONE
