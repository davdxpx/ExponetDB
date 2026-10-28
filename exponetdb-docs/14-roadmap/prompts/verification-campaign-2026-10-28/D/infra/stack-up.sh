#!/usr/bin/env bash
# Builds a complete, disposable ExponetDB from the commit under test on THIS machine (Ubuntu 24.04, root).
#
#   Control Store   PostgreSQL 17.11 in Docker (exstack-control), 127.0.0.1 only
#   serve / worker / gateway   three systemd services of the product's own bundle (node --liftoff-only), each
#                              killable and restartable alone (Restart=no)
#   targets         native PGDG clusters 16, 17, 18 ("exdbnode", ports 55416..18, 127.0.0.1, TLS from a lab CA)
#   node agent      the release build under systemd (agent + root helper), enrolled and adopting the PG17 cluster
#   owner           the first owner (software passkey + password + TOTP, STATE/owner.json, 0600)
#   CLI             built from the same commit, signed in as that owner (device flow, admin scopes + prod apply)
#   registry        product lab, project platform, targets lab/platform/{staging,production,dev16,dev18}
#
# Usage: stack-up.sh [--from PHASE] [--only PHASE]
#   phases: preflight src build control pki services targets owner cli registry agent smoke
# Repeatable: stack-down.sh, then stack-up.sh again (source and build are cached; the rest is minutes).
# Prints ids and counts only. Everything listens on 127.0.0.1.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stack-env.sh
. "${HERE}/stack-env.sh"

PHASES=(preflight src build control pki services targets owner cli registry agent smoke)
FROM=preflight; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n 2,18p "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

mkdir -p "${EXSTACK_LOGS}"
LOG="${EXSTACK_LOGS}/stack-up.log"
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
die() { log "ERROR: $*"; exit 1; }
node_run() { "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_BUNDLE}" "$@"; }
urlenc() { jq -rn --arg v "$1" '$v|@uri'; }
cred() { grep "^$1=" "${EXSTACK_STATE}/control.cred" | cut -d= -f2-; }
store_url() { printf 'postgres://%s:%s@127.0.0.1:%s/exponetdb_control' "$1" "$(urlenc "$(cred "$1")")" "${EXSTACK_PORT_CONTROL}"; }
installation_id() { cat "${EXSTACK_STATE}/installation_id"; }
heavy() { nice flock /tmp/heavy.lock "$@"; }

# ------------------------------------------------------------------------------------------------
phase_preflight() {
  [ "$(id -u)" -eq 0 ] || die "run as root"
  [ "$(uname -s)" = Linux ] || die "Linux only"
  local c
  for c in node bun go docker jq curl openssl runuser psql pg_createcluster pg_lsclusters systemctl git npm flock ss; do
    command -v "$c" >/dev/null || die "missing tool: $c"
  done
  [ "$(node --version)" = v24.22.1 ] || log "WARNING: node is $(node --version), the campaign pins v24.22.1"
  [ "$(bun --version)" = 1.4.4 ] || log "WARNING: bun is $(bun --version), the campaign pins 1.4.4"
  if [ "$FROM" = preflight ] && [ -e "${EXSTACK_STATE}/stack.up" ]; then die "a stack is already up here; run stack-down.sh first (or use --from PHASE)"; fi
  local p
  if [ "$FROM" = preflight ]; then
    for p in "${EXSTACK_PORT_CONTROL}" "${EXSTACK_PORT_SERVE}" "${EXSTACK_PORT_GATEWAY}" 55416 55417 55418 \
             "${EXSTACK_PORT_INTERNAL_SERVE}" "${EXSTACK_PORT_INTERNAL_WORKER}" "${EXSTACK_PORT_INTERNAL_GATEWAY}"; do
      ss -Hltn "sport = :$p" | grep -q . && die "port $p is already in use"
    done
  fi
  id "${EXSTACK_USER}" >/dev/null 2>&1 || useradd --system --home-dir "${EXSTACK_ROOT}" --shell /usr/sbin/nologin "${EXSTACK_USER}"
  mkdir -p "${EXSTACK_ROOT}" "${EXSTACK_BUILD}" "${EXSTACK_LOGS}"
  chmod 0755 "${EXSTACK_ROOT}" "${EXSTACK_BUILD}"
  install -d -m 0700 "${EXSTACK_STATE}" "${EXSTACK_STATE}/env" "${EXSTACK_STATE}/tls" "${EXSTACK_STATE}/pgroles"
  log "preflight ok (commit ${EXSTACK_COMMIT:0:12})"
}

# ------------------------------------------------------------------------------------------------
phase_src() {
  if [ ! -d "${EXSTACK_SRC}/.git" ]; then
    if [ -n "${EXSTACK_REPO_SEED}" ]; then
      git clone -q --no-checkout "${EXSTACK_REPO_SEED}" "${EXSTACK_SRC}"
      git -C "${EXSTACK_SRC}" remote set-url origin "${EXSTACK_REPO_URL}"
    else
      git clone -q --no-checkout "${EXSTACK_REPO_URL}" "${EXSTACK_SRC}"
    fi
  fi
  git -C "${EXSTACK_SRC}" cat-file -e "${EXSTACK_COMMIT}^{commit}" 2>/dev/null || git -C "${EXSTACK_SRC}" fetch -q origin "${EXSTACK_COMMIT}"
  git -C "${EXSTACK_SRC}" checkout -q --detach "${EXSTACK_COMMIT}"
  [ "$(git -C "${EXSTACK_SRC}" rev-parse HEAD)" = "${EXSTACK_COMMIT}" ] || die "checkout is not ${EXSTACK_COMMIT}"
  if [ ! -e "${EXSTACK_BUILD}/.install-${EXSTACK_COMMIT}" ]; then
    log "bun install --frozen-lockfile"
    (cd "${EXSTACK_SRC}" && heavy bun install --frozen-lockfile >"${EXSTACK_LOGS}/build-install.log" 2>&1) || die "bun install failed (see build-install.log)"
    touch "${EXSTACK_BUILD}/.install-${EXSTACK_COMMIT}"
  fi
  # the helper kit is a throwaway workspace package of THIS checkout only (the product tree is never edited upstream)
  rm -rf "${EXSTACK_KIT}"; mkdir -p "${EXSTACK_KIT}"
  cp -a "${HERE}/kit/." "${EXSTACK_KIT}/"
  if [ ! -d "${EXSTACK_KIT}/node_modules/@exponetdb" ]; then
    (cd "${EXSTACK_SRC}" && heavy bun install >"${EXSTACK_LOGS}/build-kit-install.log" 2>&1) || die "bun install of the kit failed"
  fi
  log "source ready: $(git -C "${EXSTACK_SRC}" log --oneline -1)"
}

# ------------------------------------------------------------------------------------------------
phase_build() {
  local m="${EXSTACK_BUILD}/.built-${EXSTACK_COMMIT}"
  if [ ! -e "$m" ]; then
    log "build: web app"
    (cd "${EXSTACK_SRC}" && heavy bun run --cwd apps/web build >"${EXSTACK_LOGS}/build-web.log" 2>&1) || die "web build failed"
    log "build: server bundle"
    (cd "${EXSTACK_SRC}" && EXPONETDB_BUILD_COMMIT="${EXSTACK_COMMIT}" heavy bun run --cwd apps/server bundle >"${EXSTACK_LOGS}/build-bundle.log" 2>&1) || die "bundle failed"
    rm -rf "${EXSTACK_BUILD}/bundle"; cp -a "${EXSTACK_SRC}/apps/server/dist/bundle" "${EXSTACK_BUILD}/bundle"
    log "build: CLI package"
    (cd "${EXSTACK_SRC}" && EXPONETDB_BUILD_COMMIT="${EXSTACK_COMMIT}" heavy bun run --cwd apps/cli pack >"${EXSTACK_LOGS}/build-cli.log" 2>&1) || die "cli pack failed"
    rm -rf "${EXSTACK_BUILD}/cli"; mkdir -p "${EXSTACK_BUILD}/cli"
    npm install --prefix "${EXSTACK_BUILD}/cli" --offline --no-audit --no-fund "${EXSTACK_SRC}"/apps/cli/dist/artifacts/exponetdb-cli-*.tgz >>"${EXSTACK_LOGS}/build-cli.log" 2>&1 || die "cli install failed"
    log "build: node agent release ${EXSTACK_AGENT_VERSION}"
    rm -rf "${EXSTACK_BUILD}/agent"
    (cd "${EXSTACK_SRC}" && heavy bash agent/node/packaging/build.sh "${EXSTACK_AGENT_VERSION}" "${EXSTACK_BUILD}/agent" >"${EXSTACK_LOGS}/build-agent.log" 2>&1) || die "agent build failed"
    touch "$m"
  fi
  [ -r "${EXSTACK_BUNDLE}" ] || die "bundle missing"
  [ -x "${EXSTACK_CLI_BIN}" ] || die "cli missing"
  log "build ready: server $(node_run version | jq -r .commit | cut -c1-12), cli $("${EXSTACK_NODE_BIN}" "${EXSTACK_CLI_BIN}" --version 2>&1 | head -1)"
}

# ------------------------------------------------------------------------------------------------
phase_control() {
  local pw="${EXSTACK_STATE}/control.superuser"
  [ -s "$pw" ] || { umask 077; head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 >"$pw"; }
  mkdir -p "${EXSTACK_CONTROL_DATA}"
  if ! docker inspect "${EXSTACK_CONTROL_NAME}" >/dev/null 2>&1; then
    log "Control Store: starting ${EXSTACK_CONTROL_NAME} (PostgreSQL 17.11, 127.0.0.1:${EXSTACK_PORT_CONTROL})"
    docker run -d --name "${EXSTACK_CONTROL_NAME}" --label purpose=exponetdb-stack \
      -e POSTGRES_PASSWORD="$(cat "$pw")" -e PGDATA=/var/lib/postgresql/data/pgdata \
      -v "${EXSTACK_CONTROL_DATA}:/var/lib/postgresql/data" \
      -p "127.0.0.1:${EXSTACK_PORT_CONTROL}:5432" "${EXSTACK_CONTROL_IMAGE}" -c max_connections=200 >/dev/null
  fi
  # the image's init server listens on the socket only: wait for a TCP answer (the final server)
  local i
  for i in $(seq 1 90); do
    docker exec -e PGPASSWORD="$(cat "$pw")" "${EXSTACK_CONTROL_NAME}" psql -h 127.0.0.1 -U postgres -tAc 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec -e PGPASSWORD="$(cat "$pw")" "${EXSTACK_CONTROL_NAME}" psql -h 127.0.0.1 -U postgres -tAc 'SELECT 1' >/dev/null || die "Control Store did not come up"
  if [ ! -s "${EXSTACK_STATE}/installation_id" ]; then
    rm -f "${EXSTACK_STATE}/control.cred" "${EXSTACK_STATE}/bootstrap.sql"
    EXPONETDB_LOG_LEVEL=warn node_run control-store bootstrap-sql --credentials-file "${EXSTACK_STATE}/control.cred" --output "${EXSTACK_STATE}/bootstrap.sql" >/dev/null
    docker exec -i -e PGPASSWORD="$(cat "$pw")" "${EXSTACK_CONTROL_NAME}" psql -X -q -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 <"${EXSTACK_STATE}/bootstrap.sql" >/dev/null
    local out
    out="$(EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_migrate)" node_run control-store migrate)" || die "control-store migrate failed"
    jq -r .installationId <<<"$out" >"${EXSTACK_STATE}/installation_id"
    log "Control Store migrated: $(jq -r '.state.status' <<<"$out"), installation $(installation_id)"
  fi
  if [ ! -s "${EXSTACK_STATE}/keyring.json" ]; then
    EXPONETDB_LOG_LEVEL=warn node_run keyring generate --key-id k1 --output "${EXSTACK_STATE}/keyring.json" >/dev/null
    chmod 0600 "${EXSTACK_STATE}/keyring.json"
  fi
  write_env
}

write_env() {
  local keyring; keyring="$(jq -c . "${EXSTACK_STATE}/keyring.json")"
  local common
  common() { printf 'EXPONETDB_CONTROL_STORE_URL=%s\nEXPONETDB_INSTALLATION_ID=%s\nEXPONETDB_KEYRING=%s\nEXPONETDB_LOG_LEVEL=info\n' "$(store_url "$1")" "$(installation_id)" "'${keyring}'"; }
  umask 077
  { common exdb_serve; cat <<EOF
EXPONETDB_ROLE=serve
EXPONETDB_LISTEN=127.0.0.1:${EXSTACK_PORT_SERVE}
EXPONETDB_PUBLIC_URL=${EXSTACK_PUBLIC_URL}
EXPONETDB_OAUTH_CLIENT_REGISTRATION=open
EXPONETDB_INTERNAL_LISTEN=127.0.0.1:${EXSTACK_PORT_INTERNAL_SERVE}
EOF
  } >"${EXSTACK_STATE}/env/serve.env"
  mkdir -p "${EXSTACK_ROOT}/audit-export"; chown "${EXSTACK_USER}" "${EXSTACK_ROOT}/audit-export"
  { common exdb_worker; cat <<EOF
EXPONETDB_ROLE=worker
EXPONETDB_INTERNAL_LISTEN=127.0.0.1:${EXSTACK_PORT_INTERNAL_WORKER}
EXPONETDB_AUDIT_EXPORT_DIR=${EXSTACK_ROOT}/audit-export
EOF
  } >"${EXSTACK_STATE}/env/worker.env"
  { common exdb_gateway; cat <<EOF
EXPONETDB_ROLE=gateway
EXPONETDB_GATEWAY_LISTEN=127.0.0.1:${EXSTACK_PORT_GATEWAY}
EXPONETDB_INTERNAL_LISTEN=127.0.0.1:${EXSTACK_PORT_INTERNAL_GATEWAY}
EOF
  } >"${EXSTACK_STATE}/env/gateway.env"
  # operator commands (bootstrap owner, node-pki): the minimal environments the commands accept
  printf 'EXPONETDB_CONTROL_STORE_URL=%s\nEXPONETDB_PUBLIC_URL=%s\nEXPONETDB_LOG_LEVEL=warn\n' "$(store_url exdb_serve)" "${EXSTACK_PUBLIC_URL}" >"${EXSTACK_STATE}/env/operator-serve.env"
  { printf 'EXPONETDB_CONTROL_STORE_URL=%s\nEXPONETDB_KEYRING=%s\nEXPONETDB_LOG_LEVEL=warn\n' "$(store_url exdb_worker)" "'${keyring}'"; } >"${EXSTACK_STATE}/env/operator-worker.env"
}

# a command with an operator environment file ('quoted' values as written by write_env)
with_env() {
  local file="$1"; shift
  ( set -a; . "${EXSTACK_STATE}/env/${file}"; set +a; "$@" )
}

# ------------------------------------------------------------------------------------------------
phase_pki() {
  if [ ! -e "${EXSTACK_STATE}/pki.done" ]; then
    local root_key="${EXSTACK_STATE}/pki-root-key.pem"; rm -f "$root_key"
    with_env operator-worker.env node_run node-pki init --gateway-url "https://127.0.0.1:${EXSTACK_PORT_GATEWAY}" \
      --server-name "${EXSTACK_GATEWAY_NAME}" --root-key-out "$root_key" >"${EXSTACK_LOGS}/pki-init.json" || die "node-pki init failed"
    with_env operator-worker.env node_run node-pki postgres-ca >"${EXSTACK_LOGS}/pki-postgres-ca.json" || die "node-pki postgres-ca failed"
    touch "${EXSTACK_STATE}/pki.done"
  fi
  log "agent PKI ready (root key in STATE, job keys: $(with_env operator-worker.env node_run node-pki job-key list | jq -c 'if type=="array" then length else (.keys // [] | length) end'))"
}

# ------------------------------------------------------------------------------------------------
unit_file() { # role
  cat <<EOF
[Unit]
Description=ExponetDB stack ${1} (disposable lab, commit under test)
After=network-online.target docker.service

[Service]
Type=simple
User=${EXSTACK_USER}
EnvironmentFile=${EXSTACK_STATE}/env/${1}.env
ExecStart=$(command -v "${EXSTACK_NODE_BIN}") --liftoff-only ${EXSTACK_BUNDLE} ${1}
# Restart=no: failure tests decide when a killed role comes back
Restart=no
KillSignal=SIGTERM
TimeoutStopSec=30s
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=${EXSTACK_ROOT}/audit-export
LimitCORE=0
EOF
}

phase_services() {
  local r
  for r in gateway worker serve; do
    unit_file "$r" >"/etc/systemd/system/${EXSTACK_UNIT_PREFIX}-${r}.service"
  done
  systemctl daemon-reload
  for r in gateway worker serve; do systemctl start "${EXSTACK_UNIT_PREFIX}-${r}.service"; done
  local i
  for i in $(seq 1 120); do stack_ready && break; sleep 1; done
  stack_ready || { journal serve | tail -20; die "serve is not ready"; }
  for r in gateway worker serve; do
    systemctl is-active --quiet "${EXSTACK_UNIT_PREFIX}-${r}.service" || die "$r is not active"
  done
  log "serve, worker, gateway running; serve ready"
}

# ------------------------------------------------------------------------------------------------
phase_targets() {
  local pkg="${EXSTACK_BUILD}/agent"
  # the agent's OS user exists before the clusters map it (pg_ident), as on a host with the packages installed
  install -m 0644 "${pkg}/sysusers.d/exponetdb-node.conf" /usr/lib/sysusers.d/ && systemd-sysusers
  local out="${EXSTACK_STATE}/nodeclusters"
  if [ ! -e "${EXSTACK_STATE}/clusters.done" ]; then
    log "targets: PostgreSQL clusters ${EXSTACK_MAJORS} (tooling/dev/node-clusters.sh)"
    EXDB_NODE_PG_VERSIONS="${EXSTACK_MAJORS}" EXDB_NODE_AGENT_USER=exponetdb-node \
      bash "${EXSTACK_SRC}/tooling/dev/node-clusters.sh" "$out" >/dev/null || die "node-clusters.sh failed"
    # TLS: a lab CA signs a server certificate with the names the registry verifies (verify-full)
    local tls="${EXSTACK_STATE}/tls"
    if [ ! -s "${tls}/ca.crt" ]; then
      openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=exponetdb stack lab CA" -keyout "${tls}/ca.key" -out "${tls}/ca.crt" 2>/dev/null
      chmod 0600 "${tls}/ca.key"; chmod 0644 "${tls}/ca.crt"
    fi
    local v etc
    for v in ${EXSTACK_MAJORS}; do
      etc="/etc/postgresql/${v}/${EXSTACK_CLUSTER_NAME}"
      printf 'subjectAltName=DNS:pg%s.exdb.test,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' "$v" >"${tls}/pg${v}.ext"
      openssl req -newkey rsa:2048 -nodes -subj "/CN=pg${v}.exdb.test" -keyout "${tls}/pg${v}.key" -out "${tls}/pg${v}.csr" 2>/dev/null
      openssl x509 -req -in "${tls}/pg${v}.csr" -CA "${tls}/ca.crt" -CAkey "${tls}/ca.key" -CAcreateserial -days 30 -extfile "${tls}/pg${v}.ext" -out "${tls}/pg${v}.crt" 2>/dev/null
      install -m 0644 -o postgres -g postgres "${tls}/pg${v}.crt" "${etc}/server.crt"
      install -m 0600 -o postgres -g postgres "${tls}/pg${v}.key" "${etc}/server.key"
      pg_ctlcluster "$v" "${EXSTACK_CLUSTER_NAME}" reload
    done
    touch "${EXSTACK_STATE}/clusters.done"
  fi
  local v listening
  for v in ${EXSTACK_MAJORS}; do
    listening="$(ss -Hltn "sport = :$((55400 + v))" | awk '{print $4}' | tr '\n' ' ')"
    case "$listening" in "127.0.0.1:$((55400 + v)) ") ;; *) die "cluster ${v} listens on: ${listening:-nothing}" ;; esac
    PGSSLMODE=require psql_target "pg${v}" -tAc 'SHOW ssl' | grep -q '^on$' || die "cluster ${v}: ssl is off"
  done
  log "targets: clusters ${EXSTACK_MAJORS} online on 127.0.0.1, ssl on"
}

# ------------------------------------------------------------------------------------------------
phase_owner() {
  if [ -s "${EXSTACK_STATE}/owner.json" ]; then log "owner already enrolled"; return; fi
  local email="${EXSTACK_OWNER_EMAIL:-owner$(printf '\100')stack.test}"
  with_env operator-serve.env node_run bootstrap owner --email "$email" --display-name "Stack Owner" \
    | (cd "${EXSTACK_KIT}" && EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_PUBLIC_URL="${EXSTACK_PUBLIC_URL}" \
         bun --conditions=@exponetdb/source human.ts enroll) | tee -a "$LOG" >&2
  [ -s "${EXSTACK_STATE}/owner.json" ] || die "owner enrollment failed"
  chmod 0600 "${EXSTACK_STATE}/owner.json"
}

# ------------------------------------------------------------------------------------------------
phase_cli() {
  local cfg="${EXSTACK_STATE}/cli"; mkdir -p "$cfg"; chmod 0700 "$cfg"
  exdb profile add stack --server "${EXSTACK_PUBLIC_URL}" --use >/dev/null || true
  local scopes; scopes="$(cd "${EXSTACK_KIT}" && bun --conditions=@exponetdb/source scopes.ts)"
  local outfile="${EXSTACK_LOGS}/cli-login.out"; : >"$outfile"
  # the loopback sign-in (PKCE): the CLI prints the authorization URL and waits on 127.0.0.1; the scripted owner opens
  # it, ticks every scope and production, and the redirect reaches the CLI, as a person's browser would deliver it
  ( EXPONETDB_CONFIG_DIR="$cfg" "${EXSTACK_NODE_BIN}" --liftoff-only "${EXSTACK_CLI_BIN}" login --no-browser --scope "$scopes" >"$outfile" 2>&1 ) &
  local pid=$! url="" i
  for i in $(seq 1 60); do
    url="$(grep -Eo 'https?://[^ ]*/oauth/authorize\?[^ ]*' "$outfile" | head -1 || true)"
    [ -n "$url" ] && break
    sleep 0.5
  done
  [ -n "$url" ] || { sed 's/code=[^& ]*/code=<r>/' "$outfile" >&2; kill "$pid" 2>/dev/null || true; die "no sign-in URL from the CLI"; }
  # shellcheck disable=SC2086
  human consent "$url" $scopes >&2
  wait "$pid" || { sed 's/code=[^& ]*/code=<r>/' "$outfile" >&2; die "CLI login failed"; }
  chmod -R go-rwx "$cfg"
  exdb auth status | tee -a "$LOG" | head -12 >&2
}

# ------------------------------------------------------------------------------------------------
phase_registry() {
  if [ -e "${EXSTACK_STATE}/registry.done" ]; then log "registry already seeded"; return; fi
  ( cd "${EXSTACK_KIT}" && EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_STATE="${EXSTACK_STATE}" \
      EXSTACK_MAJORS="${EXSTACK_MAJORS}" bun --conditions=@exponetdb/source seed.ts registry ) | tee -a "$LOG" >&2
  touch "${EXSTACK_STATE}/registry.done"
}

# ------------------------------------------------------------------------------------------------
phase_agent() {
  local pkg="${EXSTACK_BUILD}/agent" v="${EXSTACK_AGENT_VERSION}"
  if [ -e "${EXSTACK_STATE}/agent.done" ]; then log "agent already installed"; return; fi
  ( cd "$pkg" && sha256sum -c "SHA256SUMS-${v}" >/dev/null ) || die "agent release checksums do not match"
  install -m 0755 "${pkg}/exponetdb-node-${v}-linux-amd64" /usr/bin/exponetdb-node
  install -m 0755 "${pkg}/exponetdb-node-helper-${v}-linux-amd64" /usr/sbin/exponetdb-node-helper
  install -m 0644 "${pkg}/sysusers.d/exponetdb-node.conf" /usr/lib/sysusers.d/ && systemd-sysusers
  install -m 0644 "${pkg}"/tmpfiles.d/*.conf /usr/lib/tmpfiles.d/ && systemd-tmpfiles --create
  install -d -m 0755 /etc/exponetdb-node
  install -m 0644 "${pkg}"/systemd/exponetdb-node.service "${pkg}"/systemd/exponetdb-node-helper.service "${pkg}"/systemd/exponetdb-node-helper.socket /etc/systemd/system/
  install -D -m 0644 "${pkg}/doc/node-runbook.md" /usr/share/doc/exponetdb-node/node-runbook.md
  jq -n --slurpfile instances "${EXSTACK_STATE}/nodeclusters/clusters.json" \
    '{schema:"exponetdb.node-config/v1", stateDirectory:"/var/lib/exponetdb-node", helperSocket:"/run/exponetdb-node/helper.sock", agentUser:"exponetdb-node", disabledCapabilities:[], instances:$instances[0]}' \
    >/etc/exponetdb-node/config.json
  chmod 0644 /etc/exponetdb-node/config.json
  systemctl daemon-reload
  # a node enrollment for the server record (plan, apply, reveal once into a 0600 file)
  local token="${EXSTACK_STATE}/node-token"; rm -f "$token"
  ( cd "${EXSTACK_KIT}" && EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_STATE="${EXSTACK_STATE}" \
      bun --conditions=@exponetdb/source seed.ts enrollment "$token" ) | tee -a "$LOG" >&2
  runuser -u exponetdb-node -- /usr/bin/exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file - <"$token" >/dev/null || die "node enroll failed"
  shred -u "$token" 2>/dev/null || rm -f "$token"
  local fp
  fp="$(with_env operator-worker.env node_run node-pki job-key list | jq -r '[.. | objects | select(has("fingerprint")) | .fingerprint][0]')"
  /usr/sbin/exponetdb-node-helper trust --agent-state /var/lib/exponetdb-node --expect-key "$fp" >/dev/null || die "helper trust failed"
  systemctl enable --now exponetdb-node-helper.socket exponetdb-node.service >/dev/null 2>&1
  ( cd "${EXSTACK_KIT}" && EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_STATE="${EXSTACK_STATE}" \
      bun --conditions=@exponetdb/source seed.ts adopt ) | tee -a "$LOG" >&2
  touch "${EXSTACK_STATE}/agent.done"
}

# ------------------------------------------------------------------------------------------------
phase_smoke() {
  log "smoke: auth status"
  exdb auth status | head -6
  log "smoke: targets and nodes"
  exdb_json target list | jq -c '{targets: ((.data // .items // .) | length)}'
  exdb_json node list | jq -c '{nodes: ((.data // .items // .) | length)}'
  touch "${EXSTACK_STATE}/stack.up"
  log "stack is up. Reach it: source ${HERE}/stack-env.sh; exdb target list; psql_target pg17"
}

run_phase() { log "== phase $1"; "phase_$1"; }
started=0
for p in "${PHASES[@]}"; do
  if [ -n "$ONLY" ]; then [ "$p" = "$ONLY" ] && run_phase "$p"; continue; fi
  [ "$p" = "$FROM" ] && started=1
  [ "$started" = 1 ] && run_phase "$p"
done
exit 0
