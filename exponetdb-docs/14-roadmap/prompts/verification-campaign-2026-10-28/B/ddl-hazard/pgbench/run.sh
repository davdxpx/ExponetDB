#!/usr/bin/env bash
# DDL under load: for each scenario, runs the dangerous form and the safe form of a
# DDL pattern with psql WHILE pgbench drives an 80/20 read/write mix on public.orders,
# and writes one CSV row per (scenario, form): p50/p99 latency, TPS, failed queries,
# the longest stall and the apply duration.
#
# The DDL runs the way the migration engine runs it: a transactional bundle is
#   BEGIN; SET LOCAL lock_timeout; SET LOCAL statement_timeout; <sql>; COMMIT;
# a non-transactional one is session-level SETs and the statement in autocommit
# (packages/migrations-engine/src/executor.ts). The two timeouts are the engine
# defaults, read from packages/migrations/src/format/projection.ts when EXDB_TREE is
# set (lock_timeout 5 s, statement_timeout 15 min), otherwise those same values.
#
# Parameters (environment):
#   PG_VERSION=17          label for the CSV (16, 17 or 18); the server decides the real version
#   ROWS=10000000          rows in public.orders (order_items gets twice as many)
#   SETUP=1                run setup.sh first (drops and recreates the database)
#   SCENARIOS=all          or a comma list of scenario number prefixes, e.g. 01,06,16
#   FORMS=hazard,safe
#   CLIENTS=16 JOBS=4      pgbench clients / threads
#   WARMUP_SECONDS=10 STEADY_SECONDS=60 COOLDOWN_SECONDS=30
#   APPLY_BUDGET_SECONDS=1200   a step is killed after this long (timeout(1))
#   APP_TIMEOUT_MS=5000    a transaction slower than this in the apply window counts as failed
#   PGBENCH_VIA=native     or docker:<container> (pgbench from the server's image, for a machine
#                          without pgbench; logs are copied out)
#   OUT=<dir>              default ./out/<utc>-pg<version>
#   EXDB_TREE=<tree>       optional, to read the engine defaults from the code
# Libpq variables (PGHOST PGPORT PGUSER PGPASSWORD) select the server; PGDATABASE defaults to ddl_bench.
#
# Run it only on a disposable server: it creates and drops objects on a large table and
# loads the machine on purpose.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

PG_VERSION="${PG_VERSION:-17}"
ROWS="${ROWS:-10000000}"
SETUP="${SETUP:-1}"
SCENARIOS="${SCENARIOS:-all}"
FORMS="${FORMS:-hazard,safe}"
CLIENTS="${CLIENTS:-16}"
JOBS="${JOBS:-4}"
WARMUP_SECONDS="${WARMUP_SECONDS:-10}"
STEADY_SECONDS="${STEADY_SECONDS:-60}"
COOLDOWN_SECONDS="${COOLDOWN_SECONDS:-30}"
APPLY_BUDGET_SECONDS="${APPLY_BUDGET_SECONDS:-1200}"
APP_TIMEOUT_MS="${APP_TIMEOUT_MS:-5000}"
PGBENCH_VIA="${PGBENCH_VIA:-native}"
export PGDATABASE="${PGDATABASE:-ddl_bench}"
OUT="${OUT:-$here/out/$(date -u +%Y%m%dT%H%M%SZ)-pg${PG_VERSION}}"
mkdir -p "$OUT"

engine_default() { # constant name -> milliseconds, from the tree under test when available
  local f="${EXDB_TREE:-/nonexistent}/packages/migrations/src/format/projection.ts" expr
  if [ -r "$f" ]; then
    expr="$(grep -E "export const $1 =" "$f" | sed -E 's/.*= *//; s/_//g')"
    [ -n "$expr" ] && echo $((expr)) && return
  fi
  return 1
}
LOCK_TIMEOUT_MS="${LOCK_TIMEOUT_MS:-$(engine_default ENGINE_DEFAULT_LOCK_TIMEOUT_MS || echo 5000)}"
STATEMENT_TIMEOUT_MS="${STATEMENT_TIMEOUT_MS:-$(engine_default ENGINE_DEFAULT_STATEMENT_TIMEOUT_MS || echo 900000)}"

now() { date +%s.%N; }
psql_q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }

# ---------------------------------------------------------------- pgbench control
BENCH_PID=""
bench_start() { # <run dir> <total seconds>
  local dir="$1" total="$2"
  case "$PGBENCH_VIA" in
    native)
      pgbench -n -M simple -f "$here/orders_rw.sql" -D "rows=$ROWS" -c "$CLIENTS" -j "$JOBS" -T "$total" \
        -l --log-prefix="$dir/pgb" > "$dir/pgbench.out" 2> "$dir/pgbench.err" &
      BENCH_PID=$!
      ;;
    docker:*)
      local c="${PGBENCH_VIA#docker:}"
      docker exec "$c" sh -c 'mkdir -p /tmp/pgb && rm -rf /tmp/pgb/run && mkdir -p /tmp/pgb/run'
      docker cp "$here/orders_rw.sql" "$c:/tmp/pgb/orders_rw.sql" > /dev/null
      docker exec -d "$c" sh -c "cd /tmp/pgb && PGPASSWORD=\$POSTGRES_PASSWORD exec pgbench -h 127.0.0.1 -U ${PGUSER:-postgres} $PGDATABASE -n -M simple -f orders_rw.sql -D rows=$ROWS -c $CLIENTS -j $JOBS -T $total -l --log-prefix=/tmp/pgb/run/pgb > /tmp/pgb/run/out 2> /tmp/pgb/run/err"
      ;;
    *) echo "PGBENCH_VIA must be native or docker:<container>" >&2; exit 2 ;;
  esac
}
bench_stop() { # <run dir>
  local dir="$1"
  case "$PGBENCH_VIA" in
    native)
      # A background job of a non-interactive shell may start with SIGINT ignored: fall back to TERM.
      kill -INT "$BENCH_PID" 2> /dev/null; sleep 2
      kill -0 "$BENCH_PID" 2> /dev/null && kill -TERM "$BENCH_PID" 2> /dev/null
      wait "$BENCH_PID" 2> /dev/null
      ;;
    docker:*)
      local c="${PGBENCH_VIA#docker:}"
      docker exec "$c" pkill -INT pgbench; sleep 2
      docker cp "$c:/tmp/pgb/run/." "$dir/" > /dev/null
      ;;
  esac
}

# ---------------------------------------------------------------- the DDL, as the engine runs it
APPLY_OK=1; APPLY_ERR=""
run_file() { # <file>; stdout+stderr of psql, exit status of psql
  PGOPTIONS='-c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=postgres -c application_name=exponetdb/bench' \
    timeout "$APPLY_BUDGET_SECONDS" psql -X -q -v ON_ERROR_STOP=1 -f "$1" 2>&1
}
run_step() { # "<kind>[;lt=ms][;retry=n][;size=n][;sleep=s]|<sql>"
  local spec="${1%%|*}" sql="${1#*|}" kind lt="$LOCK_TIMEOUT_MS" retry=1 size=20000 pause=0.05 p
  IFS=';' read -ra parts <<< "$spec"
  kind="${parts[0]}"
  for p in "${parts[@]:1}"; do
    case "$p" in lt=*) lt="${p#lt=}" ;; retry=*) retry="${p#retry=}" ;; size=*) size="${p#size=}" ;; sleep=*) pause="${p#sleep=}" ;; esac
  done
  local f; f="$(mktemp)"
  local attempt msg rc
  case "$kind" in
    tx|nt)
      if [ "$kind" = tx ]; then
        printf "BEGIN;\nSET LOCAL lock_timeout = '%sms';\nSET LOCAL statement_timeout = '%sms';\n%s\nCOMMIT;\n" "$lt" "$STATEMENT_TIMEOUT_MS" "$sql" > "$f"
      else
        printf "SET lock_timeout = '%sms';\nSET statement_timeout = '%sms';\n%s\n" "$lt" "$STATEMENT_TIMEOUT_MS" "$sql" > "$f"
      fi
      for ((attempt = 1; attempt <= retry; attempt++)); do
        msg="$(run_file "$f")"; rc=$?
        [ $rc -eq 0 ] && break
        case "$msg" in *"lock timeout"*) [ "$attempt" -lt "$retry" ] && { sleep 1; continue; } ;; esac
        break
      done
      [ $rc -ne 0 ] && { APPLY_OK=0; APPLY_ERR="$(printf '%s' "$msg" | head -n1 | sed -E 's/^psql:[^ ]+ //' | tr ',"' '; ' | cut -c1-120) (attempts=$attempt)"; }
      ;;
    batched)
      local max lo hi
      max="$(psql_q -c 'SELECT max(id) FROM public.orders')"
      for ((lo = 1; lo <= max; lo += size)); do
        hi=$((lo + size))
        printf "SET lock_timeout = '%sms';\nSET statement_timeout = '%sms';\n%s\n" "$lt" "$STATEMENT_TIMEOUT_MS" \
          "$(printf '%s' "$sql" | sed -e "s/:lo/$lo/g" -e "s/:hi/$hi/g")" > "$f"
        msg="$(run_file "$f")" || { APPLY_OK=0; APPLY_ERR="$(printf '%s' "$msg" | head -n1 | sed -E 's/^psql:[^ ]+ //' | tr ',"' '; ' | cut -c1-120)"; break; }
        sleep "$pause"
      done
      ;;
    *) APPLY_OK=0; APPLY_ERR="unknown step kind $kind" ;;
  esac
  rm -f "$f"
}

# ---------------------------------------------------------------- environment record
{
  echo "date_utc=$(date -u +%FT%TZ)"
  echo "pg_version_label=$PG_VERSION rows=$ROWS clients=$CLIENTS jobs=$JOBS"
  echo "warmup=${WARMUP_SECONDS}s steady=${STEADY_SECONDS}s cooldown=${COOLDOWN_SECONDS}s apply_budget=${APPLY_BUDGET_SECONDS}s app_timeout=${APP_TIMEOUT_MS}ms"
  echo "engine lock_timeout=${LOCK_TIMEOUT_MS}ms statement_timeout=${STATEMENT_TIMEOUT_MS}ms"
  [ -n "${EXDB_TREE:-}" ] && echo "tree=$(git -C "$EXDB_TREE" rev-parse --short HEAD 2> /dev/null)"
  echo "kernel=$(uname -sr) cpus=$(nproc) mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
} > "$OUT/env.txt"

if [ "$SETUP" = 1 ]; then
  echo "== setup: $ROWS rows"; ROWS="$ROWS" "$here/setup.sh" || exit 1
fi
{
  psql_q -c "SELECT 'server=' || version()"
  psql_q -c "SELECT name || '=' || setting || coalesce(unit, '') FROM pg_settings WHERE name IN ('shared_buffers','max_connections','wal_level','max_wal_size','checkpoint_timeout','work_mem','maintenance_work_mem','synchronous_commit','fsync') ORDER BY 1"
} >> "$OUT/env.txt"

# ---------------------------------------------------------------- scenarios
total=$((WARMUP_SECONDS + STEADY_SECONDS + APPLY_BUDGET_SECONDS + COOLDOWN_SECONDS + 60))
for scn in "$here"/scenarios/*.scn; do
  name="$(basename "$scn" .scn)"
  if [ "$SCENARIOS" != all ]; then
    case ",$SCENARIOS," in *",${name%%-*},"*) ;; *) continue ;; esac
  fi
  for form in ${FORMS//,/ }; do
    DESC="" PREPARE="" CLEANUP="" BLOCKER="" SAFE_ENGINE=yes SAFE_NOTE="" FIXTURES=""
    HAZARD=(); SAFE=()
    # shellcheck disable=SC1090
    source "$scn"
    steps=(); [ "$form" = hazard ] && steps=("${HAZARD[@]}") || steps=("${SAFE[@]}")
    dir="$OUT/$name-$form"; mkdir -p "$dir"
    echo "== $name [$form] ${DESC}"
    [ -n "$PREPARE" ] && psql_q -c "$PREPARE" > /dev/null
    psql_q -c "ANALYZE public.orders" > /dev/null
    APPLY_OK=1; APPLY_ERR=""

    t_start="$(now)"
    bench_start "$dir" "$total"
    sleep "$WARMUP_SECONDS"; t_base="$(now)"
    sleep "$STEADY_SECONDS"
    blocker_pid=""
    if [ -n "$BLOCKER" ]; then psql_q -c "$BLOCKER" > /dev/null 2>&1 & blocker_pid=$!; sleep 1; fi
    t_apply0="$(now)"
    for s in "${steps[@]}"; do
      run_step "$s"
      [ "$APPLY_OK" = 0 ] && break
    done
    t_apply1="$(now)"
    [ -n "$blocker_pid" ] && wait "$blocker_pid" 2> /dev/null
    sleep "$COOLDOWN_SECONDS"; t_end="$(now)"
    bench_stop "$dir"

    notes="$DESC"
    [ "$form" = safe ] && [ -n "$SAFE_NOTE" ] && notes="$notes | $SAFE_NOTE"
    expressible=yes; [ "$form" = safe ] && expressible="$SAFE_ENGINE"
    python3 "$here/summarize.py" "$dir" "$t_base" "$t_apply0" "$t_apply1" "$t_end" "$APP_TIMEOUT_MS" \
      --meta "pg_version=$PG_VERSION" "rows=$ROWS" "clients=$CLIENTS" "scenario=$name" "form=$form" "steps=${#steps[@]}" \
             "apply_ok=$([ "$APPLY_OK" = 1 ] && echo yes || echo no)" "apply_error=$APPLY_ERR" \
             "apply_seconds=$(awk -v a="$t_apply0" -v b="$t_apply1" 'BEGIN { printf "%.1f", b - a }')" \
             "engine_lock_timeout_ms=$LOCK_TIMEOUT_MS" "engine_statement_timeout_ms=$STATEMENT_TIMEOUT_MS" \
             "app_timeout_ms=$APP_TIMEOUT_MS" "engine_expressible=$expressible" "notes=${notes//,/;}" \
      --csv "$OUT/results.csv" > "$dir/summary.json"
    cat "$dir/summary.json"
    # keep only the summary, not the multi-megabyte per-transaction logs
    rm -f "$dir"/pgb.* "$dir"/out "$dir"/err 2> /dev/null

    if [ -n "$CLEANUP" ]; then psql_q -c "$CLEANUP" > /dev/null 2>&1 || echo "cleanup failed for $name" >&2; fi
    psql_q -c "VACUUM (ANALYZE) public.orders" > /dev/null 2>&1
    psql_q -c "VACUUM (ANALYZE) public.order_items" > /dev/null 2>&1
    psql_q -c "CHECKPOINT" > /dev/null 2>&1 || true
  done
done
echo "== done: $OUT/results.csv"
