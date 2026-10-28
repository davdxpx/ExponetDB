source /root/lab/lib.sh
exec > >(tee $LOGS/${TAG:-new}-t11gap.log) 2>&1
mode owned; bind
ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000
BK=/var/lib/pgbackrest/backup/exdbnode
ls $ARC | cut -c1-24 | sort | tr '\n' ' '; echo
runuser -u postgres -- pgbackrest --stanza=exdbnode info 2>&1 | grep -E "wal archive min/max|backup:|WAL start/stop" | head -12
ver() {
  local R=$(rid)
  c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":null,\"snapshot\":null}" | jq -c '.error // empty'
  local out=$(wait_run $R 600)
  echo "[$1] state=$(echo "$out"|jq -r .result.state) verifyErrors=$(echo "$out"|jq -r .result.outcome.verifyErrors)"
  echo "    excerpt: $(echo "$out"|jq -r .result.excerpt | grep -iE 'ERROR|invalid|missing|status|gap' | head -6 | cut -c1-200 | tr '\n' '|')"
}
# a segment in the middle of the range the newest backup needs: second-to-last
SEGS=($(ls $ARC | cut -c1-24 | sort))
N=${#SEGS[@]}
MID=${SEGS[$((N-3))]}; LAST=${SEGS[$((N-1))]}
echo "middle=$MID last=$LAST"
F=$(ls $ARC | grep "^$MID"); cp -a $ARC/$F /root/lab/walsave/gap-mid
rm -f $ARC/$F
echo "--- raw pgbackrest verify:"; runuser -u postgres -- pgbackrest --stanza=exdbnode verify 2>&1 | grep -iE "error|missing|gap|invalid|status" | head -8 | cut -c1-220; echo "pgbackrest exit=${PIPESTATUS[0]}"
ver "deleted middle segment of the newest backup's range"
cp -a /root/lab/walsave/gap-mid $ARC/$F
F2=$(ls $ARC | grep "^$LAST"); cp -a $ARC/$F2 /root/lab/walsave/gap-last
rm -f $ARC/$F2
ver "deleted LAST segment"
cp -a /root/lab/walsave/gap-last $ARC/$F2
ver "repaired control"
