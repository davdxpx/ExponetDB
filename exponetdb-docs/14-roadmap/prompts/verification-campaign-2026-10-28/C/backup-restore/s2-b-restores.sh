# Phase B: restores through the shipped helper (restore.prepare/execute): end of archive and PITR to exact marker targets
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/b-restores.log) 2>&1
mode owned; bind
TGT=$LOGS/targets.tsv
FINAL=$(sed 's/.*id=//' $LOGS/targets.tsv.final)
echo "final marker id on the source: $FINAL"
[ -s $SRCREF ] || srcref_make
one() { # name target expectId
  restore_run "$1" "$2" "$3" || return
  if [ "$RESTORE_STATE" = succeeded ]; then restore_verify $RESTORE_RUN $RESTORE_PORT "$3"; note "restore.$1.verify" "marker<=$3 and md5s" "" "" "ok=$RV_OK"; fi
  echo "  scratch size: $(du -sb $SCR/$RESTORE_RUN 2>/dev/null | cut -f1) bytes"
  restore_discard $RESTORE_RUN
}
NEWEST=$(info_json | jq -r '.[0].backup | sort_by(.timestamp.stop) | last | .label')
echo "newest backup label: $NEWEST"
one latest-cp-style "{\"label\":\"$NEWEST\",\"time\":null,\"lsn\":null,\"timeline\":1}" $FINAL
for T in T0-idle-load T1-after-incr T2-after-diff T3-after-full2 T4-load-plus-60s; do
  line=$(grep "^$T" $TGT); id=$(echo "$line"|cut -f2); at=$(echo "$line"|cut -f3)
  iso=$(date -u -d "$at" +%Y-%m-%dT%H:%M:%S.%6NZ)
  echo "== PITR $T expect marker $id at $iso"
  one "pitr-$T" "{\"label\":null,\"time\":\"$iso\",\"lsn\":null,\"timeline\":null}" $id
done
echo B-DONE
