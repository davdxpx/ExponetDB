source /root/lab/lib.sh
exec > >(tee $LOGS/${TAG:-new}-t9lsn.log) 2>&1
mode owned; bind
psqlx "INSERT INTO public.accounts SELECT g,'l1_'||g FROM generate_series(4001,4010) g"
LSN=$(psqlx "SELECT pg_current_wal_lsn()")
psqlx "INSERT INTO public.accounts SELECT g,'l2_'||g FROM generate_series(5001,5010) g"
psqlx "SELECT pg_switch_wal()" >/dev/null; psqlx "SELECT pg_switch_wal()" >/dev/null
for i in 1 2 3 4 5 6; do runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1 && break; sleep 2; done
ROWS=$(psqlx "SELECT count(*) FROM accounts"); echo "rows=$ROWS lsn=$LSN"
t() {
  local R=$(rid) want=$3
  local prep=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$2}")
  local port=$(echo "$prep" | jq -r .result.port)
  c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$2,\"port\":$port,\"checks\":[\"recovery_target_reached\",\"probe_simple\",\"row_counts\"],\"rowCounts\":[{\"database\":\"app\",\"schema\":\"public\",\"table\":\"accounts\",\"min\":$want,\"max\":$want}]}" | jq -c '.error // empty'
  local out=$(wait_run $R 600)
  echo "[$1] -> state=$(echo "$out"|jq -r .result.state) reached=$(echo "$out"|jq -r .result.outcome.recoveryReachedLsn) checks=$(echo "$out"|jq -c '[.result.outcome.checks[]?|{(.check):.outcome}]|add')"
  c restore.discard "{\"runId\":\"$R\"}" >/dev/null
}
t "lsn no timeline" "{\"label\":null,\"time\":null,\"lsn\":\"$LSN\",\"timeline\":null}" 140
t "lsn + timeline" "{\"label\":null,\"time\":null,\"lsn\":\"$LSN\",\"timeline\":1}" 140
