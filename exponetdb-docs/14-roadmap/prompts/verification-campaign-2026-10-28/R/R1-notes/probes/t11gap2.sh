source /root/lab/lib.sh
exec > >(tee $LOGS/${TAG:-new}-t11gap2.log) 2>&1
mode owned; bind
ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000
ver() {
  local R=$(rid)
  c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":null,\"snapshot\":null}" | jq -c '.error // empty'
  local out=$(wait_run $R 600)
  echo "[$1] state=$(echo "$out"|jq -r .result.state) verifyErrors=$(echo "$out"|jq -r .result.outcome.verifyErrors)"
  echo "    excerpt: $(echo "$out"|jq -r .result.excerpt | grep -iE 'ERROR|invalid|missing|status|gap' | head -6 | cut -c1-200 | tr '\n' '|')"
}
runuser -u postgres -- pgbackrest --stanza=exdbnode info --output=json | jq -r '.[0].backup[] | "\(.label) start=\(.archive.start) stop=\(.archive.stop)"'
L=$(runuser -u postgres -- pgbackrest --stanza=exdbnode info --output=json | jq -r '.[0].backup | sort_by(.label) | last | .archive.stop')
echo "newest backup stop segment: $L"
F=$(ls $ARC | grep "^$L"); cp -a $ARC/$F /root/lab/walsave/gap2; rm -f $ARC/$F
echo "--- raw verify:"; runuser -u postgres -- pgbackrest --stanza=exdbnode verify --log-level-console=detail 2>&1 | grep -vE "command begin" | tail -12 | cut -c1-200
ver "deleted the stop segment of the newest backup"
cp -a /root/lab/walsave/gap2 $ARC/$F
ver "repaired control"
