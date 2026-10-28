source /root/lab/lib.sh
exec > >(tee $LOGS/t1b-diff-incr-list.log) 2>&1
FULL=$(cat $LOGS/last-full-run)
run1() { # kind
  local R=$(rid) T0=$(ts)
  c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"$1\",\"databases\":[]}" >/dev/null || { echo "START FAILED"; return 1; }
  local out=$(wait_run $R 900); local T1=$(ts)
  echo "$1: run=$R duration=$(echo "$T1 - $T0" | bc)s state=$(echo "$out"|jq -r .result.state) label=$(echo "$out"|jq -r .result.outcome.label) exit=$(echo "$out"|jq -r .result.exitCode)"
  echo "$out" | jq -c '.result|{runId,state,exitCode,startJobId,startArgsHash}' 
}
psqlx "INSERT INTO public.accounts SELECT g,'b'||g FROM generate_series(101,200) g"; psqlx "SELECT pg_switch_wal()" >/dev/null
echo "=== DIFFERENTIAL"; run1 differential
psqlx "INSERT INTO public.accounts SELECT g,'c'||g FROM generate_series(201,300) g"; psqlx "SELECT pg_switch_wal()" >/dev/null
echo "=== INCREMENTAL on owned"; run1 incremental
echo "=== backup.list"
c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq .
