source /root/lab/lib.sh
exec > >(tee $LOGS/t6-restore-pitr.log) 2>&1
mode owned; bind
SCR=/var/lib/exponetdb-node-engine/scratch
startrun() { local R=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"$1\",\"databases\":[]}" >/dev/null && echo $R; }
echo "=== F4: base full backup"
T0=$(ts); R=$(startrun full); out=$(wait_run $R 900); F4=$(echo "$out"|jq -r .result.outcome.label); echo "F4=$F4 state=$(echo "$out"|jq -r .result.state) $(echo "$(ts) - $T0"|bc)s"
echo $F4 > $LOGS/F4
psqlx "INSERT INTO public.accounts SELECT g,'m1_'||g FROM generate_series(1001,1010) g"; psqlx "SELECT pg_switch_wal()" >/dev/null; sleep 2
TS1=$(psqlx "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"); sleep 2
psqlx "INSERT INTO public.accounts SELECT g,'m2_'||g FROM generate_series(2001,2010) g"; psqlx "SELECT pg_switch_wal()" >/dev/null; sleep 2
TS2=$(psqlx "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"); sleep 2
psqlx "INSERT INTO public.accounts SELECT g,'m3_'||g FROM generate_series(3001,3010) g"; psqlx "SELECT pg_switch_wal()" >/dev/null; psqlx "SELECT pg_switch_wal()" >/dev/null
for i in 1 2 3 4 5 6; do runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1 && break; sleep 2; done
ROWS=$(psqlx "SELECT count(*) FROM accounts"); echo "rows now=$ROWS TS1=$TS1 TS2=$TS2"; echo "$TS1 $TS2 $ROWS" > $LOGS/ts
NULLT='{"label":null,"time":null,"lsn":null,"timeline":null}'
CHECKS='["recovery_target_reached","probe_simple","probe_extended","amcheck","row_counts"]'
drill() { # name target expectedAccounts
  local name=$1 target=$2 want=$3 R=$(rid) T0=$(ts)
  echo "--- drill [$name] run=$R target=$target expect accounts=$want"
  local prep=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$target}")
  local T1=$(ts); echo "prepare ($(echo "$T1 - $T0"|bc)s): $(echo "$prep"|jq -c '.result // .error')"
  local port=$(echo "$prep"|jq -r .result.port)
  local rc="[{\"database\":\"app\",\"schema\":\"public\",\"table\":\"accounts\",\"min\":$want,\"max\":$want},{\"database\":\"app\",\"schema\":\"public\",\"table\":\"big\",\"min\":16000000,\"max\":16000000}]"
  c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$target,\"port\":$port,\"checks\":$CHECKS,\"rowCounts\":$rc}" | jq -c '.result // .error'
  local T2=$(ts); sleep 4
  if [ -n "$SHOWUNIT" ]; then SHOWUNIT=""; echo "-- unit while restoring:"; systemctl show exponetdb-run-$R.service -p ActiveState,User,NoNewPrivileges,PrivateTmp,ProtectSystem,ProtectHome,ReadWritePaths,BindPaths,IPAddressDeny,RuntimeMaxUSec,MemoryMax,PrivateNetwork 2>&1|tr '\n' ' '; echo
    echo "-- scratch dir: $(stat -c '%U:%G %a' $SCR/$R)"; echo "-- listening TCP ports 55400-55499 / 5541x: $(ss -ltn | awk '{print $4}' | grep -E ':554[0-9][0-9]$' | tr '\n' ' ')"; ps -eo pid,user,args | grep "[p]ostgres -D $SCR/$R" | cut -c1-400; fi
  local out=$(wait_run $R 1800); local T3=$(ts)
  echo "restore.execute: $(echo "$out"|jq -r .result.state) ; start->terminal $(echo "$T3 - $T2"|bc)s ; total prepare+execute $(echo "$T3 - $T0"|bc)s"
  echo "$out" | jq -c '.result.outcome|{recoveryReachedLsn,recoveryReachedAt,timeline,checks:[.checks[]|{check,outcome,detail}],phases:[.phases[]|{name,outcome}]}'
  echo "$out" | jq -r '.result.excerpt' | tail -3 | cut -c1-300
  echo "-- after: postmaster.pid in scratch: $(ls $SCR/$R/postmaster.pid 2>&1|tail -1); procs on scratch: $(pgrep -fc "$SCR/$R")"
  LASTRUN=$R LASTPORT=$port
}
SHOWUNIT=1 drill latest "$NULLT" $((ROWS))
LATEST=$LASTRUN
drill pitr-TS2 "{\"label\":null,\"time\":\"$TS2\",\"lsn\":null,\"timeline\":null}" 320
PITR2=$LASTRUN
drill pitr-TS1 "{\"label\":null,\"time\":\"$TS1\",\"lsn\":null,\"timeline\":null}" 310
PITR1=$LASTRUN
echo "$LATEST $PITR2 $PITR1" > $LOGS/restore-runs
