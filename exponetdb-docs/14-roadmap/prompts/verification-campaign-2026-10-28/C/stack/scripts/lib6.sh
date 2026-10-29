#!/usr/bin/env bash
# S6 helpers (fail closed, keys/time, graceful life, observability, portability). SOURCE on vc-1:  . /srv/work/s6-infra/s6/lib6.sh
# Needs the kit copy /srv/work/s6-infra (S3 patches), s6.env, and a running stack "s6" (stack-up.sh).
# No secret is printed: tokens go through a 0600 header file, never through argv or stdout.
set -uo pipefail
. /srv/work/s6-infra/s6.env
. /srv/work/s6-infra/stack-env.sh
L6=${LOGS6:-/srv/work/logs-s6}; mkdir -p "$L6"
S=127.0.0.1:${EXSTACK_PORT_INTERNAL_SERVE}; W=127.0.0.1:${EXSTACK_PORT_INTERNAL_WORKER}; G=127.0.0.1:${EXSTACK_PORT_INTERNAL_GATEWAY}
API=http://127.0.0.1:${EXSTACK_PORT_SERVE}
HDR=$(mktemp /dev/shm/s6hdr.XXXXXX); chmod 600 "$HDR"
now() { date -u +%T.%3N; }
say() { printf '[%s] %s\n' "$(now)" "$*" | tee -a "$L6/s6.log" >&2; }
urlenc() { jq -rn --arg v "$1" '$v|@uri'; }
cred() { grep "^$1=" "${EXSTACK_STATE}/control.cred" | cut -d= -f2-; }
store_url() { printf 'postgres://%s:%s@127.0.0.1:%s/exponetdb_control' "$1" "$(urlenc "$(cred "$1")")" "${EXSTACK_PORT_CONTROL}"; }
node_run() { "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_BUNDLE}" "$@"; }
ro() { EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_serve)" node_run "$@"; }
cs_status() { ro control-store status; }
# bearer(): refresh the CLI sign-in (any command does), then write the access token to $HDR (0600), never to stdout
bearer() { exdb whoami >/dev/null 2>&1; { printf 'Authorization: Bearer '; jq -r --arg u "http://localhost:${EXSTACK_PORT_SERVE}" '.credentials[$u].accessToken' "${EXSTACK_STATE}/cli/credentials.json"; } >"$HDR"; }
# rest METHOD PATH [JSON]  -> "<http> <seconds>" on the first line, then the body (use REST_BODY for the file); needs bearer() first
rest() {
  local m="$1" p="$2" b="${3:-}" out=/dev/shm/s6out.last
  if [ -n "$b" ]; then
    curl -s -m "${REST_T:-30}" -o "$out" -w '%{http_code} %{time_total}\n' -X "$m" -H "@$HDR" -H 'content-type: application/json' --data-binary "$b" "$API$p"
  else
    curl -s -m "${REST_T:-30}" -o "$out" -w '%{http_code} %{time_total}\n' -X "$m" -H "@$HDR" "$API$p"
  fi
  REST_BODY="$out"; cat "$out"; echo
}
# restq: like rest, quiet body (prints only "<http> <seconds>"), body stays in /dev/shm/s6out.last
hc() { curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$1/healthz/ready"; }
hdetail() { curl -s -m 5 "http://$1/healthz/detail"; }
docker_ctl() { docker exec -i -e PGPASSWORD="$(cat "${EXSTACK_STATE}/control.superuser")" "${EXSTACK_CONTROL_NAME}" "$@"; }
# per-role readiness every 1 s into a file: epoch_ms serve worker gateway
ready_sampler() { # file seconds
  local f="$1" n="${2:-300}" i
  for i in $(seq 1 "$n"); do printf '%s %s %s %s public=%s\n' "$(date +%s.%N | cut -c1-14)" "$(hc "$S")" "$(hc "$W")" "$(hc "$G")" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$API/healthz/ready")" >>"$f"; sleep 1; done
}
audit_head() { ctl_sql "SELECT max(seq) FROM audit.audit_events"; }
logs_since() { journalctl --no-pager -o cat -u "$(_stk_unit "$1")" --since "$2" 2>/dev/null; }
trap 'rm -f "$HDR" /dev/shm/s6out.* 2>/dev/null' EXIT

# mut(): one audited mutation with the CLI token: create a plan (plan.created is audited) -> JSON line of the CLI + text of the operator message
S6P=/srv/work/s6/projects/s6p
mut_setup() { [ -d "$S6P" ] && return 0; new_project s6p >/dev/null; echo 'CREATE TABLE s6_probe(id int);' | mkb "$S6P" s6probe >/dev/null; }
mut() {
  mut_setup
  local j; j=$(cd "$S6P" && EXPONETDB_CONFIG_DIR="${EXSTACK_STATE}/cli" ${EXSTACK_NODE_BIN} --liftoff-only "${EXSTACK_CLI_BIN}" migration plan --target lab/platform/dev16 --json 2>/dev/null)
  printf '%s' "$j" | jq -c '{state:(.data.state // null), plan:(.data.id // null), errorCode:(.error.code // null), message:(.error.message // null), requestId:(.error.requestId // null), status:(.error.status // null)}' 2>/dev/null || printf 'RAW: %s\n' "$(printf '%s' "$j" | head -c 300)"
}
# mut_text(): the same, the human-readable text and exit code the operator sees (no --json)
mut_text() {
  mut_setup
  local o rc; o=$(cd "$S6P" && EXPONETDB_CONFIG_DIR="${EXSTACK_STATE}/cli" ${EXSTACK_NODE_BIN} --liftoff-only "${EXSTACK_CLI_BIN}" migration plan --target lab/platform/dev16 2>&1); rc=$?
  printf 'rc=%s | %s\n' "$rc" "$(printf '%s' "$o" | tr '\n' ' ' | head -c 400)"
}
# read_probe(): GET /api/v1/targets as the owner's CLI token -> "<http> <seconds> items=<n>"
read_probe() { local l; l=$(REST_T=${1:-10} rest GET /api/v1/targets | head -1); printf '%s items=%s\n' "$l" "$(jq -r '.items|length' /dev/shm/s6out.last 2>/dev/null || echo ?)"; }

# timeline FILE SECONDS [probe_at...]  : once per second "t=<elapsed> serve worker gateway public"; at the listed seconds also mut() and read_probe()
t0() { T0=$(date +%s.%N); }
el() { printf '%.1f' "$(echo "$(date +%s.%N) - $T0" | bc -l)"; }
timeline() {
  local n="$1"; shift; local probes=" $* " i
  for i in $(seq 0 "$n"); do
    printf 't=%s ready serve=%s worker=%s gateway=%s public=%s\n' "$(el)" "$(hc "$S")" "$(hc "$W")" "$(hc "$G")" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$API/healthz/ready")"
    case "$probes" in *" $i "*) printf '   t=%s mutation: %s\n' "$(el)" "$(mut)"; printf '   t=%s read: %s\n' "$(el)" "$(read_probe 6)";; esac
    sleep 1
  done
}
kill_cs_backends() { ctl_sql "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname='exponetdb_control' AND pid<>pg_backend_pid()"; }
