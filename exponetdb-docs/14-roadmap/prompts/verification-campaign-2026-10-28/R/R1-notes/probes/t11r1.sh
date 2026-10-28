# R1: TC-011 backup.verify against a corrupted / missing / clean real pgBackRest repository
source /root/lab/lib.sh
exec > >(tee $LOGS/${TAG:-new}-t11r1.log) 2>&1
mode owned; bind
ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000
BK=/var/lib/pgbackrest/backup/exdbnode
ver() { # name [label]
  local R=$(rid) lab=${2:-null}; [ "$lab" != null ] && lab="\"$lab\""
  c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":$lab,\"snapshot\":null}" | jq -c '.error // empty'
  local out=$(wait_run $R 600)
  echo "[$1] state=$(echo "$out"|jq -r .result.state) verifyErrors=$(echo "$out"|jq -r .result.outcome.verifyErrors) exit=$(echo "$out"|jq -r .result.exitCode)"
  echo "    excerpt: $(echo "$out"|jq -r .result.excerpt | grep -iE 'ERROR|invalid|missing|status' | head -4 | cut -c1-200 | tr '\n' '|')"
}
echo "archive segments:"; ls $ARC | head -20
ver "0 clean repository"
SEG=$(ls $ARC | grep -E '^0000000100000000000000[0-9A-F]{2}-' | sort | sed -n '4p'); echo "segment=$SEG size=$(stat -c %s $ARC/$SEG)"
mkdir -p /root/lab/walsave; cp -a $ARC/$SEG /root/lab/walsave/
SZ=$(stat -c %s $ARC/$SEG); printf '\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef' | dd of=$ARC/$SEG bs=1 seek=$((SZ/2)) conv=notrunc 2>/dev/null
ver "1 corrupt WAL segment (16 bytes flipped mid-file)"
cp -a /root/lab/walsave/$SEG $ARC/$SEG
ver "1b repaired (control)"
rm -f $ARC/$SEG
ver "2 deleted WAL segment"
cp -a /root/lab/walsave/$SEG $ARC/$SEG
# truncated WAL segment (size wrong)
truncate -s $((SZ-100)) $ARC/$SEG
ver "3 truncated WAL segment"
cp -a /root/lab/walsave/$SEG $ARC/$SEG
# backup file corruption
LBL=$(ls $BK | grep -E 'F$' | sort | head -1); echo "backup label $LBL"
FILE=$(find $BK/$LBL/pg_data/base -name '*.zst' -size +8k | head -1); echo "file=$FILE"
cp -a $FILE /root/lab/walsave/bkfile.save
FS=$(stat -c %s $FILE); printf '\xde\xad\xbe\xef\xde\xad\xbe\xef' | dd of=$FILE bs=1 seek=$((FS/2)) conv=notrunc 2>/dev/null
ver "4 corrupt backup file (whole repo)"
ver "4b corrupt backup file (label scoped)" $LBL
cp -a /root/lab/walsave/bkfile.save $FILE
rm -f $FILE
ver "5 deleted backup file (whole repo)"
cp -a /root/lab/walsave/bkfile.save $FILE
ver "6 repaired (control)"
