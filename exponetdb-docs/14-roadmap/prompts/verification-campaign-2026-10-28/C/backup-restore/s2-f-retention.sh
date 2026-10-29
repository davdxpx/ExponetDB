# Phase F4: retention. Helper-level expire at the retention boundary and what it does to the PITR window (restore.prepare for an early target).
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/f4-retention.log) 2>&1
mode owned; bind
labels() { c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -r '.result.backups|map(.label)|join(" ")'; }
walrange() { c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -r '.result.archive[]|.min+" .. "+.max'; }
prep() { local at=$1 R=$(rid); local o=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":{\"label\":null,\"time\":\"$at\",\"lsn\":null,\"timeline\":null}}"); echo "  prepare time=$at -> $(echo "$o"|jq -c '.error // {refusals:.result.refusals,walContinuous:.result.walContinuous}')"; c restore.discard "{\"runId\":\"$R\"}" >/dev/null 2>&1; }
T1=$(grep '^T1-after-incr' $LOGS/targets.tsv | cut -f3 | xargs -I{} date -u -d "{}" +%Y-%m-%dT%H:%M:%S.%6NZ)
T3=$(grep '^T3-after-full2' $LOGS/targets.tsv | cut -f3 | xargs -I{} date -u -d "{}" +%Y-%m-%dT%H:%M:%S.%6NZ)
NEWEST=$($PGB info --output=json | jq -r '.[0].backup|sort_by(.timestamp.stop)|map(select(.type=="full"))|last|.label')
echo "BEFORE: $(labels)"; echo "WAL: $(walrange)"; echo "retention-full in host config: $(grep retention-full /etc/pgbackrest/pgbackrest.conf)"
prep $T1; prep $T3
expire() { local R=$(rid) T0=$(ts); local st=$(c backup.expire "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"retention\":{\"fullCount\":$1,\"differentialCount\":null,\"logicalDays\":null},\"keepLabels\":$2}")
  if echo "$st" | jq -e .error >/dev/null; then echo "  expire fullCount=$1 keep=$2: START REFUSED: $(echo "$st"|jq -c .error)"; return; fi
  local out=$(wait_run $R 300); echo "  expire fullCount=$1 keep=$2 -> $(echo "$out"|jq -r .result.state) exit=$(echo "$out"|jq -r .result.exitCode) in $(echo "$(ts) - $T0"|bc)s"; echo "$out"|jq -r .result.excerpt | grep -E "expire|remove|archive|INFO: (expire|remove)" | head -6 | cut -c1-200; }
echo "== expire with fullCount=1 but keepLabels naming the OLDEST full (must be refused: cannot show to keep)"
OLD=$($PGB info --output=json | jq -r '.[0].backup|sort_by(.timestamp.stop)|map(select(.type=="full"))|first|.label')
expire 1 "[\"$OLD\"]"; echo "  now: $(labels)"
echo "== expire fullCount=1 keeping the newest full"
expire 1 "[\"$NEWEST\"]"; echo "  now: $(labels)"; echo "  WAL: $(walrange)"
prep $T1; prep $T3
note "retention" "expire fullCount=1" "" "" "labels after: $(labels)"
echo F4-DONE
