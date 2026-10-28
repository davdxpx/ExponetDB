source /root/lab/lab.env; source /root/lab/lib.sh
exec > >(tee $LOGS/t10-restore-target-semantics.log) 2>&1
systemctl start exponetdb-node-helper.socket
mode owned; bind
F4=$(cat $LOGS/F4); read TS1 TS2 ROWS < $LOGS/ts
LATESTLBL=$(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -r '.result.backups|map(.label)|sort|last')
echo "newest label $LATESTLBL; archive: $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.result.archive[0]')"
t() { # name target
  local R=$(rid) T0=$(ts)
  c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$2}" >/dev/null
  c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$2,\"port\":55400,\"checks\":[\"recovery_target_reached\",\"probe_simple\"],\"rowCounts\":[]}" | jq -c '.error // empty'
  local out=$(wait_run $R 600)
  echo "[$1] target=$2 -> $(echo "$out"|jq -r .result.state) reached=$(echo "$out"|jq -r .result.outcome.recoveryReachedLsn) exit=$(echo "$out"|jq -r .result.exitCode) $(echo "$(ts) - $T0"|bc)s :: $(echo "$out"|jq -r .result.excerpt|grep -E 'ERROR|target-timeline|restore command end' | head -2 | cut -c1-200 | tr '\n' '|')"
  c restore.discard "{\"runId\":\"$R\"}" >/dev/null
}
t "default + timeline" "{\"label\":null,\"time\":null,\"lsn\":null,\"timeline\":1}"
t "label only + timeline (what the CP sends for latest/older)" "{\"label\":\"$LATESTLBL\",\"time\":null,\"lsn\":null,\"timeline\":1}"
t "label only, no timeline" "{\"label\":\"$LATESTLBL\",\"time\":null,\"lsn\":null,\"timeline\":null}"
t "label+time+timeline (what the CP sends for pitr)" "{\"label\":\"$F4\",\"time\":\"$TS2\",\"lsn\":null,\"timeline\":1}"
