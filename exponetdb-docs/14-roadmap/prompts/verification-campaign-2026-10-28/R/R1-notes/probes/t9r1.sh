# R1: TC-009 restore target semantics against real pgBackRest 2.60 through the shipped, sandboxed helper
source /root/lab/lib.sh
exec > >(tee $LOGS/${TAG:-new}-t9r1.log) 2>&1
mode owned; bind
startrun() { local R=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"$1\",\"databases\":[]}" >/dev/null && echo $R; }
lbl() { local R=$(startrun $1); local out=$(wait_run $R 900); echo "$out" | jq -r .result.outcome.label; }
psqlx "CREATE TABLE IF NOT EXISTS public.filler AS SELECT g, repeat(md5(g::text), 20) AS pad FROM generate_series(1,20000) g"
F1=$(lbl full); echo "F1=$F1"
psqlx "INSERT INTO public.accounts SELECT g,'m1_'||g FROM generate_series(1001,1010) g"; psqlx "SELECT pg_switch_wal()" >/dev/null; sleep 1
TS1=$(psqlx "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"); sleep 2
psqlx "INSERT INTO public.accounts SELECT g,'m2_'||g FROM generate_series(2001,2010) g"; psqlx "SELECT pg_switch_wal()" >/dev/null; sleep 1
F2=$(lbl full); echo "F2=$F2"
psqlx "INSERT INTO public.accounts SELECT g,'m3_'||g FROM generate_series(3001,3010) g"; psqlx "SELECT pg_switch_wal()" >/dev/null; psqlx "SELECT pg_switch_wal()" >/dev/null
for i in 1 2 3 4 5 6; do runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1 && break; sleep 2; done
ROWS=$(psqlx "SELECT count(*) FROM accounts"); LSN=$(psqlx "SELECT pg_current_wal_lsn()")
echo "rows now=$ROWS TS1=$TS1 lsn=$LSN"
echo "archive: $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.result.archive[0]')"
SCR=/var/lib/exponetdb-node-engine/scratch
t() { # name target expectedRows
  local R=$(rid) T0=$(ts) want=$3
  local prep=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$2}")
  local port=$(echo "$prep" | jq -r .result.port)
  local rc="[{\"database\":\"app\",\"schema\":\"public\",\"table\":\"accounts\",\"min\":$want,\"max\":$want}]"
  c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$2,\"port\":$port,\"checks\":[\"recovery_target_reached\",\"probe_simple\",\"probe_extended\",\"amcheck\",\"row_counts\"],\"rowCounts\":$rc}" | jq -c '.error // empty'
  local out=$(wait_run $R 600)
  echo "[$1] target=$2 want=$want -> state=$(echo "$out"|jq -r .result.state) reached=$(echo "$out"|jq -r .result.outcome.recoveryReachedLsn) exit=$(echo "$out"|jq -r .result.exitCode) $(echo "$(ts) - $T0"|bc)s checks=$(echo "$out"|jq -c '[.result.outcome.checks[]?|{(.check):.outcome}]|add')"
  echo "    argv: $(echo "$out"|jq -r .result.excerpt|grep -E 'ERROR|restore command|--type' | head -2 | cut -c1-260 | tr '\n' '|')"
  c restore.discard "{\"runId\":\"$R\"}" >/dev/null
}
t "A latest as CP sends (label+timeline)" "{\"label\":\"$F2\",\"time\":null,\"lsn\":null,\"timeline\":1}" $ROWS
t "B older as CP sends (label F1 + timeline)" "{\"label\":\"$F1\",\"time\":null,\"lsn\":null,\"timeline\":1}" $ROWS
t "C label only, no timeline" "{\"label\":\"$F2\",\"time\":null,\"lsn\":null,\"timeline\":null}" $ROWS
t "D nothing" "{\"label\":null,\"time\":null,\"lsn\":null,\"timeline\":null}" $ROWS
t "E nothing + timeline" "{\"label\":null,\"time\":null,\"lsn\":null,\"timeline\":1}" $ROWS
t "F label F1 + time TS1 + timeline (pitr via CP)" "{\"label\":\"$F1\",\"time\":\"$TS1\",\"lsn\":null,\"timeline\":1}" 110
t "G time only TS1" "{\"label\":null,\"time\":\"$TS1\",\"lsn\":null,\"timeline\":null}" 110
t "H lsn + timeline" "{\"label\":null,\"time\":null,\"lsn\":\"$LSN\",\"timeline\":1}" $ROWS
