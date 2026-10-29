# S2 helper-level library (runs INSIDE s2-host as root). Source after nothing else.
source /root/lab/lib.sh
LOGS=/srv/work/s2/logs
NUM=$LOGS/numbers.tsv                      # ts  phase  detail  seconds  bytes  note
note() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "${3:-}" "${4:-}" "${5:-}" >> $NUM; }
PGB="runuser -u postgres -- pgbackrest --stanza=exdbnode"
SCR=/var/lib/exponetdb-node-engine/scratch
info_json() { $PGB info --output=json; }
# size facts of one backup label from the engine's own catalog: db size, delta, repo size (compressed, with deltas)
label_facts() { info_json | jq -r --arg l "$1" '.[0].backup[]|select(.label==$l)|[.info.size,.info.delta,.info.repository.size,.info.repository.delta,.database.id,.timestamp.start,.timestamp.stop,(.archive.start//""),(.archive.stop//"")]|@tsv'; }
repo_bytes() { du -sb /var/lib/pgbackrest | cut -f1; }
# bk KIND [label]  -> runs backup.run@1 through the shipped helper, prints one line, appends to numbers.tsv
bk() { local kind=$1 R=$(rid) T0=$(ts) out st label exitc T1 facts
  c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"$kind\",\"databases\":[]}" > $LOGS/bk-$R.start.json || { echo "START FAILED $kind"; return 1; }
  out=$(wait_run $R ${BKMAX:-3600}); T1=$(ts)
  echo "$out" > $LOGS/bk-$R.result.json
  st=$(echo "$out"|jq -r .result.state); label=$(echo "$out"|jq -r '.result.outcome.label // "-"'); exitc=$(echo "$out"|jq -r .result.exitCode)
  facts=$(label_facts "$label" 2>/dev/null || true)
  local secs=$(echo "$T1 - $T0"|bc)
  local pst=$(echo "$out"|jq -r .result.startedAt) pfi=$(echo "$out"|jq -r .result.finishedAt)
  local prod=$(echo "$(date -u -d "$pfi" +%s.%N) - $(date -u -d "$pst" +%s.%N)"|bc 2>/dev/null)
  echo "BK kind=$kind run=$R label=$label state=$st exit=$exitc wall=${secs}s facts(dbsize,delta,reposize,repodelta,id,tstart,tstop,wal0,wal1)=$facts"
  note "backup.$kind" "label=$label state=$st run=$R" "$secs" "$(echo "$facts"|cut -f3)" "product_started=$pst product_finished=$pfi product_s=$prod dbsize=$(echo "$facts"|cut -f1) delta=$(echo "$facts"|cut -f2) repodelta=$(echo "$facts"|cut -f4) tstart=$(echo "$facts"|cut -f6) tstop=$(echo "$facts"|cut -f7)"
  LASTLABEL=$label LASTRUN=$R LASTSTATE=$st
}
# wait for the archiver to catch up with the current WAL (after pg_switch_wal)
archive_catchup() { local t0=$(date +%s) want
  want=$(psqlx "SELECT pg_walfile_name(pg_switch_wal())" 2>/dev/null | head -1)
  for i in $(seq 1 240); do
    last=$(DB=postgres psqlx "SELECT last_archived_wal FROM pg_stat_archiver"); [ "$last" \> "$want" ] || [ "$last" = "$want" ] && { echo "archived $want after $(( $(date +%s)-t0 ))s"; return 0; }; sleep 1; done; echo "archive did not catch up to $want (last=$last)"; return 1; }
# marker log: lines "id|ts(db clock_timestamp)|client_return_time"
MARKLOG=$LOGS/marker.log
marker_up()   { nohup runuser -u postgres -- bash /srv/work/s2/scripts/s2-marker.sh >/dev/null 2>&1 & echo $! > $LOGS/marker.pid; }
marker_down() { [ -f $LOGS/marker.pid ] && kill $(cat $LOGS/marker.pid) 2>/dev/null; pkill -f s2-marker.sh 2>/dev/null; sleep 1.2; }
# the exact target time between marker N and N+1: client return time of the LAST marker row seen + 0.3 s
marker_target() { local last=$(tail -1 $MARKLOG); local id=${last%%|*}; local ct=${last##*|}
  local epoch=$(date -u -d "$ct" +%s.%N); local tgt=$(date -u -d "@$(echo "$epoch + 0.3"|bc)" +'%Y-%m-%d %H:%M:%S.%6N+00'); echo "$id|$tgt"; }
tsfmt() { date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ; }
mark_sum() { # N  -> count|sum(id)|md5 over rows id<=N of the (restored or live) marker table; PORT via PGPORT_OVERRIDE
  runuser -u postgres -- psql -X -q -A -t -p ${PGP:-$PGPORT} -h ${PGH:-/var/run/postgresql} -d app -c "SELECT count(*), coalesce(sum(id),0), md5(coalesce(string_agg(id::text||'@'||ts::text, ',' ORDER BY id),'')) FROM marker WHERE id <= $1"; }
tpcb_ok() { runuser -u postgres -- psql -X -q -A -t -p ${PGP:-$PGPORT} -h ${PGH:-/var/run/postgresql} -d app -c "SELECT (SELECT sum(abalance) FROM pgbench_accounts) AS a, (SELECT sum(tbalance) FROM pgbench_tellers) AS t, (SELECT sum(bbalance) FROM pgbench_branches) AS b, (SELECT coalesce(sum(delta),0) FROM pgbench_history) AS h"; }

# ---------- restores (helper level) ----------
CHECKS='["recovery_target_reached","probe_simple","probe_extended","amcheck","row_counts"]'
rowcounts() { # marker-id-or-empty
  local rc='[{"database":"app","schema":"public","table":"pgbench_accounts","min":40000000,"max":40000000},{"database":"app","schema":"public","table":"blobs","min":1000,"max":1000},{"database":"app","schema":"public","table":"docs","min":250000,"max":250000}'
  [ -n "$1" ] && rc="$rc,{\"database\":\"app\",\"schema\":\"public\",\"table\":\"marker\",\"min\":$1,\"max\":$1}"
  echo "$rc]"; }
# restore_run NAME TARGET_JSON [EXPECT_MARKER_ID]  -> RESTORE_RUN, RESTORE_PORT; stopwatch + product-reported values
restore_run() { local name=$1 target=$2 want=${3:-} R=$(rid) T0=$(ts) prep port T1 T2 out T3 s
  prep=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$target}"); T1=$(ts)
  echo "[$name] prepare $(echo "$T1 - $T0"|bc)s: $(echo "$prep"|jq -c '.result // .error')"
  port=$(echo "$prep"|jq -r '.result.port // empty'); [ -z "$port" ] && { note "restore.$name" "PREPARE REFUSED" "" "" "$(echo "$prep"|jq -c '.error')"; return 1; }
  c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$target,\"port\":$port,\"checks\":$CHECKS,\"rowCounts\":$(rowcounts "$want")}" > $LOGS/rs-$R.start.json
  T2=$(ts)
  out=$(wait_run $R ${RSMAX:-3600}); T3=$(ts)
  echo "$out" > $LOGS/rs-$R.result.json
  s=$(echo "$T3 - $T0"|bc)
  echo "[$name] state=$(echo "$out"|jq -r .result.state) exit=$(echo "$out"|jq -r .result.exitCode) wall(prepare+execute+wait)=${s}s execute-only=$(echo "$T3 - $T2"|bc)s reachedLsn=$(echo "$out"|jq -r .result.outcome.recoveryReachedLsn) reachedAt=$(echo "$out"|jq -r .result.outcome.recoveryReachedAt) timeline=$(echo "$out"|jq -r .result.outcome.timeline)"
  echo "[$name] product startedAt=$(echo "$out"|jq -r .result.startedAt) finishedAt=$(echo "$out"|jq -r .result.finishedAt)"
  echo "[$name] checks: $(echo "$out"|jq -c '[.result.outcome.checks[]?|{check,outcome,detail}]')"
  echo "[$name] phases: $(echo "$out"|jq -c '.result.outcome.phases')"
  local pst=$(echo "$out"|jq -r .result.startedAt) pfi=$(echo "$out"|jq -r .result.finishedAt)
  note "restore.$name" "run=$R state=$(echo "$out"|jq -r .result.state) target=$target" "$s" "" "product_started=$pst product_finished=$pfi reachedAt=$(echo "$out"|jq -r .result.outcome.recoveryReachedAt) execute_only=$(echo "$T3 - $T2"|bc)"
  RESTORE_RUN=$R RESTORE_PORT=$port RESTORE_STATE=$(echo "$out"|jq -r .result.state)
}
scratch_up() { local S=$SCR/$1 port=$2
  runuser -u postgres -- /usr/lib/postgresql/17/bin/postgres -D $S -c config_file=$S/exponetdb-scratch.conf -c hba_file=$S/exponetdb-scratch-hba.conf -c port=$port -c listen_addresses= -c unix_socket_directories=$S -c archive_mode=off -c ssl=off -c logging_collector=off -c hot_standby=off > $LOGS/scratch-$1.log 2>&1 &
  for i in $(seq 1 120); do runuser -u postgres -- psql -X -q -A -t -h $S -p $port -d postgres -c 'select 1' >/dev/null 2>&1 && return 0; sleep 1; done; echo "scratch did not come up"; tail -5 $LOGS/scratch-$1.log; return 1; }
scratch_down() { local S=$SCR/$1; local pid=$(head -1 $S/postmaster.pid 2>/dev/null); [ -n "$pid" ] && kill -INT $pid; for i in $(seq 1 60); do [ -f $S/postmaster.pid ] || return 0; sleep 1; done; }
SRCREF=$LOGS/srcref.txt
psql_s() { runuser -u postgres -- psql -X -q -A -t -h "$1" -p "$2" -d app -c "$3"; }
srcref_make() { { echo "blobs=$(psqlx "SELECT md5(string_agg(md5(payload),'' ORDER BY id)) FROM blobs")"; echo "docs=$(psqlx "SELECT md5(string_agg(md5(body),'' ORDER BY id)) FROM docs")"; echo "accounts=$(psqlx "SELECT count(*)||'/'||sum(aid)||'/'||sum(bid) FROM pgbench_accounts")"; } > $SRCREF; cat $SRCREF; }
# restore_verify RUNID PORT MARKER_N  -> compares marker rows (count,sum,md5) and the big tables with the source; TPC-B invariants
restore_verify() { local R=$1 port=$2 n=$3 S=$SCR/$1 ok=1 got want
  scratch_up $R $port || return 1
  want=$(mark_sum $n); got=$(PGH=$S PGP=$port mark_sum $n); echo "  marker<=$n source=$want restored=$got"; [ "$want" = "$got" ] || ok=0
  [ "$(psql_s $S $port "SELECT count(*) FROM marker")" = "$n" ] && echo "  marker total rows == $n (no row after the target)" || { echo "  marker total rows = $(psql_s $S $port "SELECT count(*) FROM marker") != $n"; ok=0; }
  for t in blobs docs; do case $t in blobs) q="SELECT md5(string_agg(md5(payload),'' ORDER BY id)) FROM blobs";; docs) q="SELECT md5(string_agg(md5(body),'' ORDER BY id)) FROM docs";; esac
    got=$(psql_s $S $port "$q"); want=$(grep "^$t=" $SRCREF|cut -d= -f2); [ "$got" = "$want" ] && echo "  $t md5 equal" || { echo "  $t md5 DIFFERS"; ok=0; }; done
  got=$(psql_s $S $port "SELECT count(*)||'/'||sum(aid)||'/'||sum(bid) FROM pgbench_accounts"); want=$(grep '^accounts=' $SRCREF|cut -d= -f2); [ "$got" = "$want" ] && echo "  accounts count/sum equal ($got)" || { echo "  accounts DIFFER $got vs $want"; ok=0; }
  got=$(PGH=$S PGP=$port tpcb_ok); echo "  TPC-B sums (accounts|tellers|branches|history) = $got"; python3 - "$got" <<'PY' || ok=0
import sys; v=sys.argv[1].split('|'); sys.exit(0 if len(set(v[:3]))==1 else 1)  # history is truncated by every pgbench start, so only accounts=tellers=branches
PY
  scratch_down $R; echo "  restore_verify ok=$ok"; RV_OK=$ok; }
restore_discard() { local T0=$(ts); local out=$(c restore.discard "{\"runId\":\"$1\"}"); echo "discard $1: $(echo "$out"|jq -c '.result // .error') in $(echo "$(ts) - $T0"|bc)s"; }
