#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2155
# Configuration and helper functions of the disposable ExponetDB stack.
# SOURCE this file (it changes nothing by itself):
#
#     source stack-env.sh          # from stack-up.sh, stack-down.sh and from a tester's shell
#
# Local overrides (per server) are read from /etc/exstack.env when it exists, so the same scripts
# serve more than one machine. Nothing here prints a secret; helpers print ids, states and counts.
#
# Helpers (all documented in README.md):
#   exdb ...                     the CLI of the commit under test, signed in as the first owner (admin scopes)
#   psql_target pg16|pg17|pg18   psql as the local postgres superuser on a target cluster (PGDATABASE selects the database)
#   psql_control ...             psql as the superuser on the Control Store (read evidence: operations, plans, audit)
#   ctl_sql "SELECT ..."         one tuples-only query on the Control Store
#   kill_role serve|worker|gateway|agent|helper|control [SIGNAL]   signal a stack process (default KILL)
#   start_role|stop_role|restart_role <role>                        systemd / docker control of one process
#   restart_cp                   restart gateway, worker and serve in order and wait for readiness
#   stack_status                 states, ports and health of everything, ids and counts only
#   stack_ready                  exit 0 when serve answers readiness
#   pg_restart pg17 [immediate|fast|smart]   restart a target cluster (immediate = SIGQUIT, like pg_ctl -m immediate)
#   human ...                    act as the owner (human.ts): call, apply, approve, stepup, device-approve
#   op_state <operation id>      state / applyOutcome / verificationOutcome of an operation from the Control Store
#   journal <role> [args]        journalctl of a role's unit
#   target_id lab/platform/staging   the id of a target (from ids.json)

# --- configuration ---------------------------------------------------------------------------
[ -r /etc/exstack.env ] && . /etc/exstack.env

: "${EXSTACK_ROOT:=/srv/work/stack}"
: "${EXSTACK_LOGS:=${EXSTACK_ROOT}/logs}"
: "${EXSTACK_COMMIT:=d51da5d0d8832ebc569f23985c7e5176e4d450ad}"       # commit under test (merge of fix PR 46)
: "${EXSTACK_REPO_URL:=https://github.com/davdxpx/ExponetDB.git}"
: "${EXSTACK_REPO_SEED:=}"                                             # optional local git dir to clone from (faster)
: "${EXSTACK_AGENT_VERSION:=0.7.0}"
: "${EXSTACK_NODE_BIN:=node}"
: "${EXSTACK_USER:=exstack}"                                           # unprivileged user of serve, worker, gateway

EXSTACK_SRC="${EXSTACK_ROOT}/src"
EXSTACK_BUILD="${EXSTACK_ROOT}/build"
EXSTACK_STATE="${EXSTACK_ROOT}/state"                                  # 0700, every secret lives here
EXSTACK_BUNDLE="${EXSTACK_BUILD}/bundle/bin/exponetdb.mjs"
EXSTACK_CLI_BIN="${EXSTACK_BUILD}/cli/node_modules/.bin/exponetdb"
EXSTACK_KIT="${EXSTACK_SRC}/packages/stack-kit"
EXSTACK_CONTROL_NAME=exstack-control
EXSTACK_CONTROL_IMAGE='postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f'
EXSTACK_CONTROL_DATA="${EXSTACK_CONTROL_DATA:-${EXSTACK_ROOT}/control-data}"

# Every port is on 127.0.0.1. PostgreSQL targets: 55400 + major (tooling/dev/node-clusters.sh fixes 554NN).
: "${EXSTACK_PORT_CONTROL:=58432}"
: "${EXSTACK_PORT_SERVE:=58480}"
: "${EXSTACK_PORT_GATEWAY:=58443}"      # the agent listener (HTTP/2 mTLS)
: "${EXSTACK_PORT_INTERNAL_SERVE:=58481}"
: "${EXSTACK_PORT_INTERNAL_WORKER:=58482}"
: "${EXSTACK_PORT_INTERNAL_GATEWAY:=58483}"
: "${EXSTACK_PUBLIC_URL:=http://localhost:${EXSTACK_PORT_SERVE}}"
: "${EXSTACK_GATEWAY_NAME:=gateway.exdb.test}"
: "${EXSTACK_MAJORS:=16 17 18}"
EXSTACK_UNIT_PREFIX=exstack
EXSTACK_CLUSTER_NAME=exdbnode           # tooling/dev/node-clusters.sh names every cluster this

export TZ=UTC
export NO_COLOR=1 FORCE_COLOR=0

# --- small helpers -----------------------------------------------------------------------------
_stk_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
_stk_die() { _stk_log "ERROR: $*"; return 1 2>/dev/null || exit 1; }
_stk_port() { case "$1" in pg16) echo 55416;; pg17) echo 55417;; pg18) echo 55418;; *) return 1;; esac; }
_stk_major() { echo "${1#pg}"; }

_stk_unit() {
  case "$1" in
    serve|worker|gateway) echo "${EXSTACK_UNIT_PREFIX}-$1.service" ;;
    agent) echo exponetdb-node.service ;;
    helper) echo exponetdb-node-helper.service ;;
    *) return 1 ;;
  esac
}

# --- the CLI as the first owner -----------------------------------------------------------------
exdb() { EXPONETDB_CONFIG_DIR="${EXSTACK_STATE}/cli" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" "$@" 2>&1 || return $?; }
# the same, bypassing the stack's own wrapper noise: exit code and stdout only
exdb_json() { EXPONETDB_CONFIG_DIR="${EXSTACK_STATE}/cli" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" "$@" --json 2>/dev/null; }

# --- the owner as a person (passkey, step-up, approvals) -----------------------------------------
human() {
  ( cd "${EXSTACK_KIT}" && EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_STATE="${EXSTACK_STATE}" \
      EXSTACK_PUBLIC_URL="${EXSTACK_PUBLIC_URL}" bun --conditions=@exponetdb/source human.ts "$@" )
}

# --- targets and the Control Store ---------------------------------------------------------------
psql_target() {
  local name="${1:?pg16|pg17|pg18}"; shift
  local port; port="$(_stk_port "$name")" || { _stk_die "unknown target $name"; return 1; }
  PGDATABASE="${PGDATABASE:-postgres}" runuser -u postgres -- psql -X -p "$port" "$@"
}

psql_control() {
  docker exec -i -e PGPASSWORD="$(cat "${EXSTACK_STATE}/control.superuser")" "${EXSTACK_CONTROL_NAME}" \
    psql -X -h 127.0.0.1 -U postgres -d "${PGDATABASE_CONTROL:-exponetdb_control}" "$@"
}
ctl_sql() { psql_control -v ON_ERROR_STOP=1 -At -c "$1"; }

op_state() { ctl_sql "SELECT state||' apply='||apply_outcome||' verify='||verification_outcome||' kind='||kind FROM operations.operations WHERE operation_id='${1:?operation id}'"; }

target_id() { jq -r --arg p "${1:?lab/platform/staging}" '.["target_" + ($p | split("/")[2])] // empty' "${EXSTACK_STATE}/ids.json"; }
stack_id() { jq -r --arg k "${1:?key}" '.[$k] // empty' "${EXSTACK_STATE}/ids.json"; }

# --- processes -------------------------------------------------------------------------------------
journal() { local u; u="$(_stk_unit "${1:?role}")" || return 1; shift; journalctl --no-pager -o cat -u "$u" "$@"; }

kill_role() {
  local role="${1:?serve|worker|gateway|agent|helper|control}" sig="${2:-KILL}"
  if [ "$role" = control ]; then docker kill --signal="$sig" "${EXSTACK_CONTROL_NAME}" >/dev/null; return; fi
  local u; u="$(_stk_unit "$role")" || return 1
  local pid; pid="$(systemctl show -p MainPID --value "$u")"
  [ "$pid" != 0 ] || { _stk_log "$role is not running"; return 1; }
  kill -s "$sig" "$pid" && _stk_log "sent SIG$sig to $role (main pid $pid)"
}

start_role() {
  if [ "$1" = control ]; then docker start "${EXSTACK_CONTROL_NAME}" >/dev/null; _stk_wait_control; return; fi
  systemctl start "$(_stk_unit "$1")"
}
stop_role() {
  if [ "$1" = control ]; then docker stop "${EXSTACK_CONTROL_NAME}" >/dev/null; return; fi
  systemctl stop "$(_stk_unit "$1")"
}
restart_role() {
  if [ "$1" = control ]; then docker restart "${EXSTACK_CONTROL_NAME}" >/dev/null; _stk_wait_control; return; fi
  systemctl restart "$(_stk_unit "$1")"
}

_stk_wait_control() {
  local i
  for i in $(seq 1 90); do
    docker exec "${EXSTACK_CONTROL_NAME}" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

stack_ready() { curl -fsS -m 3 -o /dev/null "http://127.0.0.1:${EXSTACK_PORT_INTERNAL_SERVE}/healthz/ready"; }

restart_cp() {
  local r
  for r in gateway worker serve; do systemctl restart "$(_stk_unit "$r")"; done
  local i
  for i in $(seq 1 90); do stack_ready && { _stk_log "control plane ready"; return 0; }; sleep 1; done
  _stk_die "serve not ready after 90 s"
}

pg_restart() {
  local name="${1:?pg16|pg17|pg18}" mode="${2:-fast}" major; major="$(_stk_major "$name")"
  local unit="postgresql@${major}-${EXSTACK_CLUSTER_NAME}.service"
  case "$mode" in
    immediate)
      # pg_ctl -m immediate = SIGQUIT to the postmaster: no shutdown checkpoint, crash recovery on start.
      local pid; pid="$(head -1 "/var/lib/postgresql/${major}/${EXSTACK_CLUSTER_NAME}/postmaster.pid")"
      kill -QUIT "$pid"
      local i; for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      systemctl start "$unit" ;;
    fast|smart) systemctl restart "$unit" ;;
    *) _stk_die "mode: immediate|fast|smart"; return 1 ;;
  esac
}

stack_status() {
  local r u
  for r in serve worker gateway agent helper; do
    u="$(_stk_unit "$r")"
    printf '%-8s %-10s pid=%s\n' "$r" "$(systemctl is-active "$u" 2>/dev/null)" "$(systemctl show -p MainPID --value "$u" 2>/dev/null)"
  done
  printf '%-8s %s\n' control "$(docker inspect -f '{{.State.Status}}' "${EXSTACK_CONTROL_NAME}" 2>/dev/null || echo absent)"
  local n
  for n in pg16 pg17 pg18; do
    printf '%-8s %s port=%s\n' "$n" "$(pg_lsclusters -h 2>/dev/null | awk -v v="${n#pg}" -v c="${EXSTACK_CLUSTER_NAME}" '$1==v && $2==c {print $4}')" "$(_stk_port "$n")"
  done
  if stack_ready; then echo "serve    ready (readiness 200)"; else echo "serve    NOT ready"; fi
  [ -r "${EXSTACK_STATE}/ids.json" ] && jq -r 'to_entries | map(select(.key|test("^target_"))) | length | "targets  \(.) registered"' "${EXSTACK_STATE}/ids.json"
}
