# Phase D (inside s2-host2): restore on ANOTHER host from the repository only (read-only mount), with the offline runbook the product generated.
LOGS=/srv/work/s2/logs; X=/srv/work/s2/xfer; RB=$X/runbook-main.sh
exec > >(tee -a $LOGS/d-host2.log) 2>&1
note() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "${3:-}" "${4:-}" "${5:-}" >> $LOGS/numbers.tsv; }
PB=/usr/lib/postgresql/17/bin
echo "host2: $(hostname); repository mount: $(grep ' /var/lib/pgbackrest ' /proc/mounts | awk '{print $4}' | cut -d, -f1) (ro = repository cannot be modified from this host)"
echo "no cluster on host2: $(pg_lsclusters | tail -n +2 | grep -c exdbnode)"
r2() { # name port type target nExpected
  local name=$1 port=$2 type=$3 target=$4 n=$5 d=/var/lib/postgresql/r2-$1 T0 T1 rc
  rm -rf $d $d.exponetdb
  T0=$(date +%s.%N)
  runuser -u postgres -- env TARGET_DIR=$d PG_BIN=$PB PORT=$port CIPHER_PASS_FILE=$X/cipher.pass ${type:+RESTORE_TYPE=$type} ${target:+RESTORE_TARGET="$target"} sh $RB > $LOGS/host2-$name.out 2>&1; rc=$?
  T1=$(date +%s.%N); local secs=$(echo "$T1 - $T0"|bc)
  echo "[$name] runbook rc=$rc wall=${secs}s; last lines: $(tail -3 $LOGS/host2-$name.out | tr '\n' '|' | cut -c1-260)"
  local sock=$d.exponetdb/socket
  local q="runuser -u postgres -- $PB/psql -X -q -A -t -h $sock -p $port -d app -c"
  local got=$($q "SELECT count(*), coalesce(sum(id),0), md5(coalesce(string_agg(id::text||'@'||ts::text, ',' ORDER BY id),'')) FROM marker WHERE id <= $n"); local want=$(cat $X/expected-$n.txt)
  local tot=$($q "SELECT count(*) FROM marker")
  echo "[$name] marker<=$n restored=$got expected=$want total=$tot $([ "$got" = "$want" ] && [ "$tot" = "$n" ] && echo MATCH || echo MISMATCH)"
  local blobs=$($q "SELECT md5(string_agg(md5(payload),'' ORDER BY id)) FROM blobs") docs=$($q "SELECT md5(string_agg(md5(body),'' ORDER BY id)) FROM docs")
  echo "[$name] blobs $([ "$blobs" = "$(grep ^blobs= $LOGS/srcref.txt|cut -d= -f2)" ] && echo equal || echo DIFFERS) docs $([ "$docs" = "$(grep ^docs= $LOGS/srcref.txt|cut -d= -f2)" ] && echo equal || echo DIFFERS); tpcb: $($q "SELECT (SELECT sum(abalance) FROM pgbench_accounts)||'|'||(SELECT sum(tbalance) FROM pgbench_tellers)||'|'||(SELECT sum(bbalance) FROM pgbench_branches)")"
  note "restore.host2.$name" "type=${type:-default} target=${target:-end-of-archive} rc=$rc" "$secs" "" "marker<=$n: $([ "$got" = "$want" ] && echo match || echo MISMATCH)"
  runuser -u postgres -- $PB/pg_ctl -D $d stop -m fast >/dev/null 2>&1; rm -rf $d $d.exponetdb
}
r2 end 55451 "" "" 502
r2 pitrT3 55452 time "2026-10-28 20:56:46.201362+00" 324
r2 pitrT1 55453 time "2026-10-28 20:54:35.753400+00" 199
echo D-DONE
