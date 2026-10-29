# Phase E1: failure injection at helper level: helper backup.verify (whole repo) + restore latest with marker check, per case
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/e1-fail-helper.log) 2>&1
mode owned; bind
# fresh commits at the very end of the archive: 25 s of 1 Hz marker rows, then a segment switch, so that the LAST archived segment holds committed data
marker_up; sleep 25; marker_down; archive_catchup
FINAL=$(tail -1 $MARKLOG | cut -d'|' -f1)
echo "source final marker id: $FINAL"
srcref_make >/dev/null
verify_all() { local R=$(rid) T0=$(ts); c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":null,\"snapshot\":null}" >/dev/null; local o=$(wait_run $R 1800); echo "  helper backup.verify (whole repo): state=$(echo "$o"|jq -r .result.state) verifyErrors=$(echo "$o"|jq -r .result.outcome.verifyErrors) in $(echo "$(ts) - $T0"|bc)s"; echo "$o" | jq -r .result.excerpt | grep -E "status:|invalid|missing|ERROR|error" | head -4 | cut -c1-220; }
verify_label() { local R=$(rid) T0=$(ts) NEW=$($PGB info --output=json | jq -r '.[0].backup|sort_by(.timestamp.stop)|last|.label'); c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":\"$NEW\",\"snapshot\":null}" >/dev/null; local o=$(wait_run $R 1800); echo "  helper backup.verify label=$NEW: state=$(echo "$o"|jq -r .result.state) verifyErrors=$(echo "$o"|jq -r .result.outcome.verifyErrors) in $(echo "$(ts) - $T0"|bc)s"; }
rl() { RESTORE_STATE=not-started; restore_run "$1" '{"label":null,"time":null,"lsn":null,"timeline":null}' "$FINAL"; echo "  restore state=$RESTORE_STATE"
  if [ "$RESTORE_STATE" = succeeded ]; then
    local S=$SCR/$RESTORE_RUN; scratch_up $RESTORE_RUN $RESTORE_PORT && { echo "  restored marker rows: $(psql_s $S $RESTORE_PORT "SELECT count(*)||' (max id '||coalesce(max(id),0)||')' FROM marker") vs source final $FINAL"; scratch_down $RESTORE_RUN; }
  fi
  restore_discard $RESTORE_RUN; }
for CASE in "$@"; do
  echo "=================== CASE $CASE ($(date -u +%T))"
  bash /srv/work/s2/scripts/s2-inject.sh $CASE apply
  verify_all
  verify_label
  rl "fail-$CASE"
  bash /srv/work/s2/scripts/s2-inject.sh $CASE revert
  echo "  after repair: $(runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1)"
done
echo E1-DONE
