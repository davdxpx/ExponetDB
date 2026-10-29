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
#   net_block <port> [drop|reject] / net_unblock   block (or restore) loopback TCP to a port for every process (chain EXSTACK_FAIL; stack-down removes it)
#   net_delay <ms> [loss%]      netem delay/loss on lo (affects the whole loopback); net_clear removes it
#   human ...                    act as the owner (human.ts): call, apply, approve, stepup, device-approve
#   op_state <operation id>      state / applyOutcome / verificationOutcome of an operation from the Control Store
#   journal <role> [args]        journalctl of a role's unit
#   target_id lab/platform/staging   the id of a target (from ids.json)
#   new_project NAME             a scratch project dir (EXSTACK_ROOT/projects/NAME) for lab/platform; prints the path
#   mkb DIR SLUG [flags] < up.sql   a new bundle (flags of `migration new`, e.g. --nontransactional); VERIFY_SQL overrides verify.sql, DOWN_SQL adds a rollback script; prints its id
#   mplan DIR TARGET [ids...]    plan from the bundles in DIR; sets PLAN_ID, PLAN_STATE; prints one line
#   mapply [PLAN] [flags]        `plan apply` (default --wait unless flags are given); sets OP_ID; prints the operation as the Control Store has it
#   add_target SLUG pg17 [prod]  one more environment + database + target lab/platform/SLUG (fresh state for a test); prints the path
#   ledger pg17 lab_staging      the target's ledger rows (ids, checksum prefix, transactional, operation)

# --- configuration ---------------------------------------------------------------------------
EXSTACK_INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -r /etc/exstack.env ] && . /etc/exstack.env

# Parameters (environment or /etc/exstack.env). The short names are accepted too:
#   STACK_NAME  (EXSTACK_NAME)   names the root dir, systemd units and Control Store container; default "stack"
#   COMMIT      (EXSTACK_COMMIT)  the commit to build: a full or abbreviated sha, e.g. COMMIT=d0229550 for the pre-fix release
#   PORT_BASE   (EXSTACK_PORT_BASE) 58400: Control Store +32, agent listener +43, serve +80, internal probes +81..+83
#   PG_PORT_BASE (EXSTACK_PG_PORT_BASE) 55400: target clusters at base+16, +17, +18
#   AGENT=0     skip the node agent (the agent is one per host: a second stack on the same host needs AGENT=0)
: "${EXSTACK_NAME:=${STACK_NAME:-stack}}"
: "${EXSTACK_ROOT:=/srv/work/${EXSTACK_NAME}}"
: "${EXSTACK_LOGS:=${EXSTACK_ROOT}/logs}"
: "${EXSTACK_COMMIT:=${COMMIT:-d51da5d0d8832ebc569f23985c7e5176e4d450ad}}"   # default: the commit under test (merge of fix PR 46)
: "${EXSTACK_REPO_URL:=https://github.com/davdxpx/ExponetDB.git}"
: "${EXSTACK_REPO_SEED:=}"                                             # optional local git dir to clone from (faster)
: "${EXSTACK_AGENT_VERSION:=0.7.0}"
: "${EXSTACK_AGENT:=${AGENT:-1}}"
: "${EXSTACK_NODE_BIN:=node}"
: "${EXSTACK_USER:=exstack}"                                           # unprivileged user of serve, worker, gateway

EXSTACK_SRC="${EXSTACK_ROOT}/src"
EXSTACK_BUILD="${EXSTACK_ROOT}/build"
EXSTACK_STATE="${EXSTACK_ROOT}/state"                                  # 0700, every secret lives here
EXSTACK_BUNDLE="${EXSTACK_BUILD}/bundle/bin/exponetdb.mjs"
EXSTACK_CLI_BIN="${EXSTACK_BUILD}/cli/node_modules/.bin/exponetdb"
EXSTACK_KIT="${EXSTACK_SRC}/packages/stack-kit"
EXSTACK_UNIT_PREFIX="ex${EXSTACK_NAME}"                               # exstack-serve.service, ...
EXSTACK_CONTROL_NAME="${EXSTACK_UNIT_PREFIX}-control"
EXSTACK_CONTROL_IMAGE='postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f'
EXSTACK_CONTROL_DATA="${EXSTACK_CONTROL_DATA:-${EXSTACK_ROOT}/control-data}"

# Every port is on 127.0.0.1.
: "${EXSTACK_PORT_BASE:=${PORT_BASE:-58400}}"
: "${EXSTACK_PG_PORT_BASE:=${PG_PORT_BASE:-55400}}"
: "${EXSTACK_PORT_CONTROL:=$((EXSTACK_PORT_BASE + 32))}"
: "${EXSTACK_PORT_GATEWAY:=$((EXSTACK_PORT_BASE + 43))}"                # the agent listener (HTTP/2 mTLS)
: "${EXSTACK_PORT_SERVE:=$((EXSTACK_PORT_BASE + 80))}"
: "${EXSTACK_PORT_INTERNAL_SERVE:=$((EXSTACK_PORT_BASE + 81))}"
: "${EXSTACK_PORT_INTERNAL_WORKER:=$((EXSTACK_PORT_BASE + 82))}"
: "${EXSTACK_PORT_INTERNAL_GATEWAY:=$((EXSTACK_PORT_BASE + 83))}"
: "${EXSTACK_PUBLIC_URL:=http://localhost:${EXSTACK_PORT_SERVE}}"
: "${EXSTACK_GATEWAY_NAME:=gateway.exdb.test}"
: "${EXSTACK_MAJORS:=16 17 18}"
# tooling/dev/node-clusters.sh names every cluster "exdbnode" (the product's host tests expect that for the default stack)
if [ "${EXSTACK_NAME}" = stack ]; then : "${EXSTACK_CLUSTER_NAME:=exdbnode}"; else : "${EXSTACK_CLUSTER_NAME:=ex${EXSTACK_NAME}}"; fi

export TZ=UTC
export NO_COLOR=1 FORCE_COLOR=0

# --- small helpers -----------------------------------------------------------------------------
_stk_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
_stk_die() { _stk_log "ERROR: $*"; return 1 2>/dev/null || exit 1; }
_stk_port() { case "$1" in pg16|pg17|pg18) echo $((EXSTACK_PG_PORT_BASE + ${1#pg}));; *) return 1;; esac; }
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

_stk_super() { cat "${EXSTACK_STATE}/control.superuser.name" 2>/dev/null || echo postgres; }
psql_control() {
  docker exec -i -e PGPASSWORD="$(cat "${EXSTACK_STATE}/control.superuser")" "${EXSTACK_CONTROL_NAME}" \
    psql -X -h 127.0.0.1 -U "$(_stk_super)" -d "${PGDATABASE_CONTROL:-exponetdb_control}" "$@"
}
ctl_sql() { psql_control -v ON_ERROR_STOP=1 -At -c "$1"; }

op_state() { ctl_sql "SELECT state||' apply='||apply_outcome||' verify='||verification_outcome||' kind='||kind FROM operations.operations WHERE operation_id='${1:?operation id}'"; }

target_id() { jq -r --arg p "${1:?lab/platform/staging}" '.["target_" + ($p | split("/")[2])] // empty' "${EXSTACK_STATE}/ids.json"; }
stack_id() { jq -r --arg k "${1:?key}" '.[$k] // empty' "${EXSTACK_STATE}/ids.json"; }

# --- Control Store: container, backup the way the runbook says, loss and restore --------------------------
# control_container_start [superuser]  creates and starts the Control Store container on an EMPTY data directory
control_container_start() {
  local super="${1:-postgres}" pw="${EXSTACK_STATE}/control.superuser"
  [ -s "$pw" ] || { ( umask 077; head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 >"$pw" ); }
  printf '%s' "$super" >"${EXSTACK_STATE}/control.superuser.name"
  mkdir -p "${EXSTACK_CONTROL_DATA}"
  docker run -d --name "${EXSTACK_CONTROL_NAME}" --label purpose=exponetdb-stack \
    -e POSTGRES_USER="$super" -e POSTGRES_PASSWORD="$(cat "$pw")" -e PGDATA=/var/lib/postgresql/data/pgdata \
    -v "${EXSTACK_CONTROL_DATA}:/var/lib/postgresql/data" \
    -p "127.0.0.1:${EXSTACK_PORT_CONTROL}:5432" "${EXSTACK_CONTROL_IMAGE}" -c max_connections=200 >/dev/null
  # the image's init server listens on the socket only: wait for a TCP answer (the final server)
  local i
  for i in $(seq 1 120); do
    docker exec -e PGPASSWORD="$(cat "$pw")" "${EXSTACK_CONTROL_NAME}" psql -h 127.0.0.1 -U "$super" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# cs_dump [file]   a complete pg_dumpall of the Control Store (control-store-runbook.md section 3), gzip, 0600.
#                  Prints path, size and sha256 only.
cs_dump() {
  local dir="${EXSTACK_STATE}/dumps" f
  mkdir -p "$dir"; chmod 0700 "$dir"
  f="${1:-${dir}/control-$(date -u +%Y%m%dT%H%M%SZ).sql.gz}"
  ( umask 077; docker exec -e PGPASSWORD="$(cat "${EXSTACK_STATE}/control.superuser")" "${EXSTACK_CONTROL_NAME}" \
      pg_dumpall -h 127.0.0.1 -U "$(_stk_super)" | gzip -c >"$f" ) || { _stk_log "pg_dumpall failed"; return 1; }
  printf 'dump %s bytes=%s sha256=%s\n' "$f" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -c1-16)"
}

# cs_wipe   simulates the loss of the Control Store: stops the three roles, removes the container AND its data, and
#           starts a new EMPTY PostgreSQL 17 with the temporary superuser restore_admin (RB-10 step 2: a name that is
#           none of the roles in the export). The roles stay stopped. Nothing of the dead system is kept but the
#           role-credentials file and the keyring in STATE (the runbook says to keep those offline).
cs_wipe() {
  local r
  for r in serve worker gateway; do systemctl stop "$(_stk_unit "$r")" 2>/dev/null; done
  docker rm -f "${EXSTACK_CONTROL_NAME}" >/dev/null 2>&1
  rm -rf "${EXSTACK_CONTROL_DATA}"
  control_container_start restore_admin && _stk_log "Control Store wiped; empty PostgreSQL 17, superuser restore_admin, roles stopped"
}

# cs_restore file   RB-10 step 2: feed the pg_dumpall export to the empty server with ON_ERROR_STOP.
#                   Step 3 onward (control-store status, audit verify, keyring) and step 5 (start the roles) are the
#                   caller's: cs_status, then restart_cp.
cs_restore() {
  local f="${1:?dump file (.sql or .sql.gz)}" cat_=cat
  case "$f" in *.gz) cat_="gzip -dc" ;; esac
  $cat_ "$f" | docker exec -i -e PGPASSWORD="$(cat "${EXSTACK_STATE}/control.superuser")" "${EXSTACK_CONTROL_NAME}" \
    psql -X -q -h 127.0.0.1 -U "$(_stk_super)" -d postgres -v ON_ERROR_STOP=1 >/dev/null || { _stk_log "restore failed"; return 1; }
  _stk_log "dump restored"
}

# cs_status   control-store status with the runtime login exdb_serve (JSON: status, installation id, bundle counts)
cs_status() {
  ( set -a; . "${EXSTACK_STATE}/env/operator-serve.env"; set +a
    "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_BUNDLE}" control-store status )
}

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
    docker exec "${EXSTACK_CONTROL_NAME}" pg_isready -h 127.0.0.1 -U "$(_stk_super)" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

stack_ready() { curl -fs -m 3 -o /dev/null "http://127.0.0.1:${EXSTACK_PORT_INTERNAL_SERVE}/healthz/ready"; }

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

# --- migration authoring and driving (the scratch projects of the tests) -------------------------------
EXSTACK_PROJECTS="${EXSTACK_ROOT}/projects"

new_project() {
  local name="${1:?name}" dir="${EXSTACK_PROJECTS}/${1}"
  rm -rf "$dir"; mkdir -p "$dir"
  ( cd "$dir" && exdb init --project lab/platform >/dev/null \
      && sed -i 's/role: migrator/role: owner/; s/migrator: app_migrator/owner: lab_owner/' exponetdb.project.yaml ) || return 1
  echo "$dir"
}

mkb() {
  local dir="${1:?project dir}" slug="${2:?slug}"; shift 2
  local out id d
  out="$(cd "$dir" && exdb migration new "$slug" "$@")" || { echo "$out" >&2; return 1; }
  id="$(awk '/^Migration:/ {print $2}' <<<"$out")"
  d="$(ls -d "$dir"/migrations/"${id}"_*)"
  cat >"$d/up.sql"
  if [ -n "${VERIFY_SQL:-}" ]; then printf '%s\n' "$VERIFY_SQL" >"$d/verify.sql"; fi
  if [ -n "${DOWN_SQL:-}" ]; then   # an optional rollback script: down.sql plus the manifest block that names it
    printf '%s\n' "$DOWN_SQL" >"$d/down.sql"
    printf 'rollback:\n  script: down.sql\n  safety: unsafe\n  notes: |\n    test rollback\n' >>"$d/migration.yaml"
  fi
  echo "$id"
}

PLAN_ID=""; PLAN_STATE=""; OP_ID=""
mplan() {
  local dir="${1:?project dir}" target="${2:?target path}"; shift 2
  local j rc
  j="$(cd "$dir" && exdb_json migration plan --target "$target" "$@")"; rc=$?
  PLAN_ID="$(jq -r '.data.id // .planId // empty' <<<"$j")"
  PLAN_STATE="$(jq -r '.data.state // empty' <<<"$j")"
  echo "plan=${PLAN_ID:-none} state=${PLAN_STATE:-?} decision=$(jq -r '.data.decision // "?"' <<<"$j") error=$(jq -r '.error.code // "-"' <<<"$j") rc=$rc"
  return $rc
}

mapply() {
  local plan="${1:-$PLAN_ID}"; shift || true
  local args=("$@"); [ ${#args[@]} -eq 0 ] && args=(--wait)
  local j rc
  j="$(exdb_json plan apply "$plan" "${args[@]}")"; rc=$?
  OP_ID="$(jq -r '.operationId // .data.operationId // (if (.data.id // "" | startswith("op_")) then .data.id else empty end)' <<<"$j")"
  echo "op=${OP_ID:-none} rc=$rc error=$(jq -r '.error.code // "-"' <<<"$j") store: $( if [ -n "$OP_ID" ]; then op_state "$OP_ID"; else echo '-'; fi)"
  return $rc
}

ledger() {
  PGDATABASE="${2:?database}" psql_target "${1:?pg17}" -Atc \
    "SELECT migration_id||' '||name||' '||left(checksum,28)||' tx='||coalesce(transactional::text,'?')||' op='||operation_id FROM exponetdb.schema_migrations ORDER BY applied_seq"
}

add_target() {
  local slug="${1:?slug}" name="${2:-pg17}" tier="${3:-nonprod}"
  kit_sync || return 1
  ( cd "${EXSTACK_KIT}" && EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_STATE="${EXSTACK_STATE}" \
      EXSTACK_PG_PORT_BASE="${EXSTACK_PG_PORT_BASE}" bun --conditions=@exponetdb/source seed.ts add-target "$slug" "${name#pg}" "$tier" ) >&2 || return 1
  echo "lab/platform/${slug}"
}

# copies the helper kit next to this file into the checkout's workspace package (after the kit changed)
kit_sync() { rsync -a --exclude node_modules "${EXSTACK_INFRA}/kit/" "${EXSTACK_KIT}/"; }

# --- failure injection on the loopback (every stack process talks over 127.0.0.1) --------------------------------
net_block() { # port [drop|reject]
  local port="${1:?port}" how="${2:-reject}" target=REJECT extra=(--reject-with tcp-reset)
  [ "$how" = drop ] && { target=DROP; extra=(); }
  iptables -N EXSTACK_FAIL 2>/dev/null
  iptables -C OUTPUT -j EXSTACK_FAIL 2>/dev/null || iptables -I OUTPUT 1 -j EXSTACK_FAIL
  iptables -A EXSTACK_FAIL -p tcp --dport "$port" -j "$target" "${extra[@]}"
  _stk_log "blocked tcp/$port ($how)"
}
net_unblock() {
  iptables -F EXSTACK_FAIL 2>/dev/null
  _stk_log "loopback blocks removed"
}
net_delay() { # ms [loss percent]
  tc qdisc replace dev lo root netem delay "${1:?ms}ms" ${2:+loss "${2}%"} && _stk_log "netem on lo: delay ${1}ms loss ${2:-0}%"
}
net_clear() { tc qdisc del dev lo root 2>/dev/null; _stk_log "netem removed"; }

# makes catalog reads slow (a verification then takes seconds): n empty tables in a target database
bloat() { # pgNN database [n]
  PGDATABASE="${2:?database}" psql_target "${1:?pg16}" -q -c "DO \$\$ BEGIN FOR i IN 1..${3:-1500} LOOP EXECUTE format('CREATE TABLE public.bulk_%s (id int primary key, a text, b text)', i); END LOOP; END \$\$"
}

# runs CMD (eval) the moment the operation row shows STATE (polled every ~50 ms from the Control Store)
inject_on_state() { # opid state "cmd" [timeout seconds]
  local op="${1:?op}" st="${2:?state}" cmd="${3:?cmd}" end=$(( $(date +%s) + ${4:-120} )) cur
  while [ "$(date +%s)" -lt "$end" ]; do
    cur="$(ctl_sql "SELECT state FROM operations.operations WHERE operation_id='${op}'" 2>/dev/null)"
    if [ "$cur" = "$st" ]; then eval "$cmd"; _stk_log "injected on state=$cur"; return 0; fi
    sleep 0.05
  done
  return 1
}

# cli_login   (re)signs the CLI in as the first owner with every scope it may hold: the loopback sign-in (PKCE) with the
#             scripted owner delivering consent and the redirect, as a person's browser would. Use it after the grant
#             was revoked or the refresh token ended.
cli_login() {
  local cfg="${EXSTACK_STATE}/cli"; mkdir -p "$cfg"; chmod 0700 "$cfg"
  exdb profile add stack --server "${EXSTACK_PUBLIC_URL}" --use >/dev/null || true
  local scopes; scopes="$(cd "${EXSTACK_KIT}" && bun --conditions=@exponetdb/source scopes.ts)"
  local outfile="${EXSTACK_LOGS}/cli-login.out"; : >"$outfile"
  ( EXPONETDB_CONFIG_DIR="$cfg" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" login --no-browser --scope "$scopes" >"$outfile" 2>&1 ) &
  local pid=$! url="" i
  for i in $(seq 1 60); do
    url="$(grep -Eo 'https?://[^ ]*/oauth/authorize\?[^ ]*' "$outfile" | head -1 || true)"
    [ -n "$url" ] && break
    sleep 0.5
  done
  [ -n "$url" ] || { sed 's/code=[^& ]*/code=<r>/' "$outfile" >&2; kill "$pid" 2>/dev/null; _stk_die "no sign-in URL from the CLI"; return 1; }
  # shellcheck disable=SC2086
  human consent "$url" $scopes >&2
  wait "$pid" || { sed 's/code=[^& ]*/code=<r>/' "$outfile" >&2; _stk_die "CLI login failed"; return 1; }
  chmod -R go-rwx "$cfg"
}

