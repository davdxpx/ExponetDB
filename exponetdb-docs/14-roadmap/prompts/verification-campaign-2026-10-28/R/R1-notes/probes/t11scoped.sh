source /root/lab/lib.sh
exec > >(tee $LOGS/${TAG:-new}-t11scoped.log) 2>&1
mode owned; bind
ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000
info=$(runuser -u postgres -- pgbackrest --stanza=exdbnode info --output=json)
LBL=$(echo "$info" | jq -r '.[0].backup | sort_by(.label) | last | .label'); START=$(echo "$info" | jq -r '.[0].backup | sort_by(.label) | last | .archive.start'); STOP=$(echo "$info" | jq -r '.[0].backup | sort_by(.label) | last | .archive.stop')
echo "newest=$LBL start=$START stop=$STOP"
ver() { local R=$(rid); c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":\"$LBL\",\"snapshot\":null}" | jq -c '.error // empty'; local out=$(wait_run $R 600)
  echo "[$1] label-scoped verify: state=$(echo "$out"|jq -r .result.state) verifyErrors=$(echo "$out"|jq -r .result.outcome.verifyErrors)"; }
corrupt() { local F=$(ls $ARC | grep "^$1" | head -1); cp -a $ARC/$F /root/lab/walsave/sc.save; local SZ=$(stat -c %s $ARC/$F); printf '\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef' | dd of=$ARC/$F bs=1 seek=$((SZ/2)) conv=notrunc 2>/dev/null; echo $F; }
restore() { cp -a /root/lab/walsave/sc.save $ARC/$1; }
F=$(corrupt $STOP); ver "corrupt STOP segment of the newest backup"; restore $F
F=$(corrupt $START); ver "corrupt START segment of the newest backup"; restore $F
LAST=$(ls $ARC | cut -c1-24 | sort -u | tail -1)
F=$(corrupt $LAST); ver "corrupt LAST archived segment (after the backup)"; restore $F
ver "repaired control"
