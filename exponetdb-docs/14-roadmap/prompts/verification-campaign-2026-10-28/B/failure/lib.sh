#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2155
# Shared helpers of the stack-level invariant and failure scripts (verification campaign 2026-10-28, tester S1).
# SOURCE it after the stack is up:   source lib.sh
#
# Environment: INFRA (the folder with stack-env.sh, default /srv/work/infra-s1), RUN_TAG (default: time based),
# S1_LOGS (raw logs, default /srv/work/logs-s1; nothing in there is committed).
# Every script prints  VERDICT <id>: PASS|FAIL|PARTIAL|NOT_RUN - <reason>  and appends it to $S1_LOGS/verdicts.tsv.
set -uo pipefail
INFRA="${INFRA:-/srv/work/infra-s1}"
# shellcheck source=/dev/null
. "${INFRA}/stack-env.sh"
S1_LOGS="${S1_LOGS:-/srv/work/logs-s1}"
mkdir -p "${S1_LOGS}"
RUN_TAG="${RUN_TAG:-$(date -u +%d%H%M)}"
VERDICTS="${S1_LOGS}/verdicts.tsv"

verdict() { # id verdict reason
  printf 'VERDICT %s: %s - %s\n' "$1" "$2" "$3"
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" >>"${VERDICTS}"
}
note() { printf '  . %s\n' "$*"; }
nowms() { date +%s%3N; }

# the public tables of a target database (the test objects live there), sorted, comma separated; "-" when none
tables_in() { # pgNN db
  local out
  out="$(PGDATABASE="$2" psql_target "$1" -Atc "SELECT coalesce(string_agg(relname, ',' ORDER BY relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')" 2>&1)" || { echo "ERR($out)"; return; }
  echo "${out:--}"
}
ledger_count() { # pgNN db migration_id  -> 0|1
  PGDATABASE="$2" psql_target "$1" -Atc "SELECT count(*) FROM exponetdb.schema_migrations WHERE migration_id='$3'" 2>/dev/null || echo "?"
}
event_summary() { # pgNN db migration_id -> "kind,kind,..." from the target's event log
  PGDATABASE="$2" psql_target "$1" -Atc "SELECT coalesce(string_agg(event_kind, ',' ORDER BY event_seq), '-') FROM exponetdb.migration_events WHERE migration_id='$3'" 2>/dev/null || echo "?"
}

# lint summary of a project dir: "rc=1 blocking=error:forbidden_statement,warn:table_without_grant warnings=3"
lint_summary() { # dir
  local j rc
  j="$(cd "$1" && exdb_json migration lint)"; rc=$?
  echo "rc=${rc} blocking=$(jq -r '[.data.bundles[]?.findings[]? | select(.blocking) | .level + ":" + .rule] | unique | join(",")' <<<"$j" 2>/dev/null) findings=$(jq -r '[.data.bundles[]?.findings[]?] | length' <<<"$j" 2>/dev/null)"
}

# wait until the operation reaches one of the (space separated) states, up to $3 seconds; prints the last row
wait_state() { # opid "state state" [seconds]
  local op="$1" want="$2" end=$(( $(date +%s) + ${3:-120} )) row=""
  while [ "$(date +%s)" -lt "$end" ]; do
    row="$(op_state "$op" 2>/dev/null || true)"
    local st="${row%% *}"
    case " $want " in *" $st "*) echo "$row"; return 0 ;; esac
    sleep 0.5
  done
  echo "$row"; return 1
}

# a fresh target on a cluster, named by the case (a new environment, database and registration)
fresh_target() { # slug pgNN [prod]
  add_target "i${RUN_TAG}$1" "${2:-pg17}" "${3:-nonprod}" 2>>"${S1_LOGS}/fresh-target.log"
}
target_db() { echo "lab_${1#lab/platform/}"; }   # lab/platform/slug -> lab_slug

# COMMIT that never returns: with synchronous_standby_names naming a standby that does not exist, a commit that wrote
# flushes its WAL locally and then waits (wait_event SyncRep) for an acknowledgement that never comes. The change IS
# committed and visible, the client has no reply: the situation of "connection lost between COMMIT and the reply".
syncrep_on()  { psql_target "${1:?pg16}" -q -c "ALTER SYSTEM SET synchronous_standby_names = 'ghost_standby'" -c "SELECT pg_reload_conf()" >/dev/null; }
syncrep_off() { # works with the cluster running or stopped
  local name="${1:?pg16}" major; major="$(_stk_major "$name")"
  if psql_target "$name" -Atc 'select 1' >/dev/null 2>&1; then
    psql_target "$name" -q -c "ALTER SYSTEM RESET synchronous_standby_names" -c "SELECT pg_reload_conf()" >/dev/null
  else
    sed -i '/synchronous_standby_names/d' "/var/lib/postgresql/${major}/${EXSTACK_CLUSTER_NAME}/postgresql.auto.conf" 2>/dev/null
  fi
}
syncrep_waiting() { # pgNN db -> number of sessions stuck in a commit wait
  PGDATABASE="$2" psql_target "$1" -Atc "SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'SyncRep' AND pid <> pg_backend_pid()" 2>/dev/null || echo 0
}

