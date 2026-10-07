#!/usr/bin/env bash
# Creates the disposable PostgreSQL clusters of the node agent's integration
# tests (Wave 5 Phase 5): one cluster per major (16, 17, 18) with the Debian
# packaging layout the agent manages (pg_createcluster, /etc/postgresql,
# conf.d, pg_ctlcluster, the postgresql@ unit), the agent's role
# `exponetdb_node` (superuser, local socket, peer authentication mapped from
# the running OS user only, security.md §3), dedicated TLS files, and a JSON
# description of the instances in the shape of the operator configuration.
# EXDB_NODE_AGENT_USER may name several OS users, separated by spaces (the
# capability tests run as root; the end-to-end test runs the agent as an
# unprivileged user, because the helper refuses root as its caller).
#
# Development and CI only, on a disposable machine: needs root, the
# PostgreSQL packages (postgresql-16/17/18 from the distribution or PGDG),
# and drops and recreates clusters named `exdbnode`. Never run it on a host
# with real data.
#
# Usage: sudo tooling/dev/node-clusters.sh [output directory]   (default .exdb-dev-node)
# Prints `export EXDB_NODE_CLUSTERS=<dir>/clusters.json` for `eval`.
set -euo pipefail
out="${1:-.exdb-dev-node}"
versions="${EXDB_NODE_PG_VERSIONS:-16 17 18}"
name="exdbnode"
agent_user="${EXDB_NODE_AGENT_USER:-${SUDO_USER:-$(id -un)}}"
if [ "$(id -u)" -ne 0 ]; then
  echo "node-clusters.sh: run as root (it creates PostgreSQL clusters)" >&2
  exit 1
fi
umask 077
mkdir -p "$out"
out="$(cd "$out" && pwd)"
entries=()
for v in $versions; do
  port="554$v"
  etc="/etc/postgresql/$v/$name"
  data="/var/lib/postgresql/$v/$name"
  if pg_lsclusters -h | awk '{print $1"/"$2}' | grep -qx "$v/$name"; then
    pg_dropcluster --stop "$v" "$name" >/dev/null
  fi
  pg_createcluster "$v" "$name" -p "$port" -- --auth-local=peer --auth-host=scram-sha-256 >/dev/null
  # Dedicated TLS files (the instance's own, never the shared snakeoil).
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 \
    -subj "/CN=$name-$v.exdb.test" -keyout "$etc/server.key" -out "$etc/server.crt" 2>/dev/null
  chown postgres:postgres "$etc/server.key" "$etc/server.crt"
  chmod 0600 "$etc/server.key"
  chmod 0644 "$etc/server.crt"
  sed -i -e "s|^#\?ssl_cert_file.*|ssl_cert_file = '$etc/server.crt'|" \
    -e "s|^#\?ssl_key_file.*|ssl_key_file = '$etc/server.key'|" \
    -e "s|^#\?ssl = .*|ssl = on|" "$etc/postgresql.conf"
  # The agent's access: the named OS users only, as exponetdb_node.
  for u in $agent_user; do
    printf 'exponetdb %s exponetdb_node\n' "$u" >>"$etc/pg_ident.conf"
  done
  { printf 'local all exponetdb_node peer map=exponetdb\n'; cat "$etc/pg_hba.conf"; } >"$etc/pg_hba.conf.new"
  mv "$etc/pg_hba.conf.new" "$etc/pg_hba.conf"
  chown postgres:postgres "$etc/pg_hba.conf"
  chmod 0640 "$etc/pg_hba.conf"
  pg_ctlcluster "$v" "$name" start
  runuser -u postgres -- psql -X -q -p "$port" -c "CREATE ROLE exponetdb_node SUPERUSER LOGIN" postgres
  entries+=("$(printf '{"localName":"%s/%s","unit":"postgresql@%s-%s.service","port":%s,"socketDirectory":"/var/run/postgresql","dataDirectory":"%s","configFile":"%s/postgresql.conf","hbaFile":"%s/pg_hba.conf","managedInclude":"%s/conf.d/90-exponetdb.conf","tlsCertificateFile":"%s/server.crt","tlsKeyFile":"%s/server.key"}' \
    "$v" "$name" "$v" "$name" "$port" "$data" "$etc" "$etc" "$etc" "$etc" "$etc")")
done
(IFS=,; printf '[%s]\n' "${entries[*]}") >"$out/clusters.json"
chmod 0644 "$out/clusters.json"
chmod 0755 "$out"
echo "export EXDB_NODE_CLUSTERS=$out/clusters.json"
