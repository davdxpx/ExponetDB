source /root/lab/lib.sh
exec > >(tee $LOGS/t1c-expire.log) 2>&1
mode owned; bind
labels() { c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -r '.result.backups|map(.label)|join(" ")'; }
F1=20261027-201556F; D1=20261027-201556F_20261027-201721D; F2=20261027-202418F; F3=20261027-202504F
walrange() { c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -r '.result.archive[]|.min+" .. "+.max'; }
expire() { # name full keep(json array)
  local R=$(rid) T0=$(ts); local st=$(c backup.expire "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"retention\":{\"fullCount\":$2,\"differentialCount\":null,\"logicalDays\":null},\"keepLabels\":$3}")
  if echo "$st" | jq -e .error >/dev/null; then echo "[$1] START REFUSED: $(echo "$st"|jq -c .error)"; return; fi
  local out=$(wait_run $R 300); echo "[$1] fullCount=$2 keep=$3 -> $(echo "$out"|jq -r .result.state) in $(echo "$(ts) - $T0"|bc)s :: $(echo "$out"|jq -r '.result.excerpt|.[0:200]'|tr '\n' ' ')"
}
echo "BEFORE: $(labels)"; echo "WAL: $(walrange)"
expire "keep F1 but retention 1 full" 1 "[\"$F1\"]";  echo "now: $(labels)"
expire "keep F2 (second newest) retention 1" 1 "[\"$F2\"]"; echo "now: $(labels)"
expire "keep diff of F1, retention 2 fulls?? (F1 is oldest of 3)" 2 "[\"$D1\"]"; echo "now: $(labels)"
expire "retention 2, keep newest two" 2 "[\"$F2\",\"$F3\"]"; echo "AFTER (kept labels F2 F3 must exist): $(labels)"; echo "WAL: $(walrange)"
expire "retention 2 again is a no-op" 2 "[\"$F3\"]"; echo "now: $(labels)"
