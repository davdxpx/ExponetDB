#!/usr/bin/env bash
# S3 helpers (upgrade rehearsal, rollback, Control Store loss). SOURCE on vc-1:  . /srv/work/s3-infra/s3/lib.sh
# Needs /srv/work/s3-infra (the kit copy with the S3 patches: kit-s3.patch) and s3.env.
set -uo pipefail
S3_INFRA=/srv/work/s3-infra
. "${S3_INFRA}/s3.env"
. "${S3_INFRA}/stack-env.sh"
S3_LOGS="${EXSTACK_LOGS}"                       # /srv/work/s3/logs  (raw logs, never committed)
S3_DIR="${S3_INFRA}/s3"
TIMINGS="${S3_LOGS}/timings.tsv"
NEW_ROOT=/srv/work/s3new                        # build of the commit under test (stack-up --only build)
OLD_ROOT=/srv/work/s3                           # build of d0229550

now() { date -u +%FT%T.%3NZ; }
epoch_ms() { date +%s%3N; }
say() { printf '[%s] %s\n' "$(date -u +%T.%3N)" "$*" | tee -a "${S3_LOGS}/s3.log" >&2; }
# timing <phase> <detail> <ms> [note]    appends to timings.tsv
timing() { printf '%s\t%s\t%s\t%s\t%s\n' "$(now)" "$1" "$2" "$3" "${4:-}" >>"${TIMINGS}"; }
# timed <phase> <detail> cmd...   runs cmd, records the wall time in ms, returns its exit code
timed() { local ph="$1" de="$2"; shift 2; local t0 t1 rc; t0=$(epoch_ms); "$@"; rc=$?; t1=$(epoch_ms); timing "$ph" "$de" "$((t1 - t0))" "rc=$rc"; return $rc; }

urlenc() { jq -rn --arg v "$1" '$v|@uri'; }
cred() { grep "^$1=" "${EXSTACK_STATE}/control.cred" | cut -d= -f2-; }
store_url() { printf 'postgres://%s:%s@127.0.0.1:%s/exponetdb_control' "$1" "$(urlenc "$(cred "$1")")" "${EXSTACK_PORT_CONTROL}"; }

# release switch: which build the shell functions (exdb, human, cs_status) use
s3_release() { # old|new
  case "$1" in
    old) export EXSTACK_BUILD=${OLD_ROOT}/build EXSTACK_BUNDLE=${OLD_ROOT}/build/bundle/bin/exponetdb.mjs EXSTACK_CLI_BIN=${OLD_ROOT}/build/cli/node_modules/.bin/exponetdb EXSTACK_KIT=${OLD_ROOT}/src/packages/stack-kit ;;
    new) export EXSTACK_BUILD=${NEW_ROOT}/build EXSTACK_BUNDLE=${NEW_ROOT}/build/bundle/bin/exponetdb.mjs EXSTACK_CLI_BIN=${NEW_ROOT}/build/cli/node_modules/.bin/exponetdb EXSTACK_KIT=${NEW_ROOT}/src/packages/stack-kit ;;
    *) echo "old|new" >&2; return 1 ;;
  esac
  S3_REL="$1"
}
node_run() { "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_BUNDLE}" "$@"; }

# the three roles' units: point them at the old or the new bundle (the stand-in for "set the image tag")
s3_units() { # old|new   rewrites ExecStart of the three units; does not restart anything
  local b r
  [ "$1" = new ] && b=${NEW_ROOT}/build/bundle/bin/exponetdb.mjs || b=${OLD_ROOT}/build/bundle/bin/exponetdb.mjs
  for r in gateway worker serve; do
    sed -i "s|^ExecStart=.*|ExecStart=$(command -v node) --liftoff-only ${b} ${r}|" "/etc/systemd/system/${EXSTACK_UNIT_PREFIX}-${r}.service"
  done
  systemctl daemon-reload
}
s3_stop_timeout() { # seconds   TimeoutStopSec of the three units (docker stop --time N stand-in)
  local r; for r in gateway worker serve; do sed -i "s|^TimeoutStopSec=.*|TimeoutStopSec=${1}s|" "/etc/systemd/system/${EXSTACK_UNIT_PREFIX}-${r}.service"; done; systemctl daemon-reload
}

# readiness sampler: one line per transition of each role's /healthz/ready (and of the public port), 50 ms resolution
sampler_start() { # logfile
  nohup node "${S3_DIR}/sampler.mjs" "$EXSTACK_PORT_INTERNAL_SERVE" "$EXSTACK_PORT_INTERNAL_WORKER" "$EXSTACK_PORT_INTERNAL_GATEWAY" "$EXSTACK_PORT_SERVE" >"$1" 2>&1 &
  SAMPLER_PID=$!
}
sampler_stop() { kill "${SAMPLER_PID:-0}" 2>/dev/null; wait "${SAMPLER_PID:-0}" 2>/dev/null; }

role_versions() { local r p; for r in serve:$EXSTACK_PORT_INTERNAL_SERVE worker:$EXSTACK_PORT_INTERNAL_WORKER gateway:$EXSTACK_PORT_INTERNAL_GATEWAY; do p=${r#*:}; printf '%s ready=%s build=%s\n' "${r%%:*}" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/healthz/ready")" "$(curl -s -m 3 "http://127.0.0.1:$p/healthz/ready" | head -c 300)"; done; }

# read-only operator commands (control-store status, audit verify): the new release refuses PUBLIC_URL/KEYRING on them
# ("not_used_by_readonly_store"), so the kit's operator-serve.env cannot be used for them (kit patch: this override)
ro() { EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_serve)" node_run "$@"; }
cs_status() { ro control-store status; }
