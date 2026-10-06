#!/usr/bin/env bash
# Starts the disposable managed-target servers of the Wave 4 tests
# (packages/testkit, local-development.md, test-strategy.md): PostgreSQL 16,
# 17 and 18 with pgvector and pg_trgm, TLS only (`hostssl`, plaintext
# rejected by pg_hba) with a server certificate from a throwaway CA generated
# here, plus one PostgreSQL 17 without TLS for the plaintext-refusal tests.
#
# Development and CI only: the CA, the keys and the superuser password are
# generated for this run, live in the output directory (git-ignored), and are
# never used for anything else. Images are pinned by digest.
#
# Usage: tooling/dev/targets.sh [output directory]   (default .exdb-dev-targets)
# Prints `export EXDB_TEST_TARGETS=<dir>/targets.json` for `eval`.
set -euo pipefail
out="${1:-.exdb-dev-targets}"
prefix="${EXDB_DEV_TARGET_PREFIX:-exdb-target}"
base_port="${EXDB_DEV_TARGET_BASE_PORT:-555}"
declare -A images=(
  [16]="pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a"
  [17]="pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d"
  [18]="pgvector/pgvector:pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11"
)
server_name="pg.exdb.test"
umask 077
mkdir -p "$out"
out="$(cd "$out" && pwd)"

if [ ! -f "$out/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=exponetdb test CA" \
    -keyout "$out/ca.key" -out "$out/ca.crt" 2>/dev/null
  # An unrelated CA: a certificate it did not sign must be refused.
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=exponetdb unrelated CA" \
    -keyout "$out/other-ca.key" -out "$out/other-ca.crt" 2>/dev/null
  printf 'subjectAltName=DNS:%s,DNS:localhost\nextendedKeyUsage=serverAuth\n' "$server_name" >"$out/ext.cnf"
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$server_name" \
    -keyout "$out/server.key" -out "$out/server.csr" 2>/dev/null
  openssl x509 -req -in "$out/server.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" \
    -CAcreateserial -days 30 -extfile "$out/ext.cnf" -out "$out/server.crt" 2>/dev/null
  # TLS for every TCP client, plaintext refused; the socket stays for docker exec.
  printf 'local all all trust\nhostssl all all all scram-sha-256\nhostnossl all all all reject\n' >"$out/pg_hba.conf"
  head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 >"$out/superuser"
fi
chmod 644 "$out/server.crt" "$out/server.key" "$out/pg_hba.conf" "$out/ca.crt" "$out/other-ca.crt"
password="$(cat "$out/superuser")"

start() {
  local name="$1" image="$2" port="$3" tls="$4"
  if docker inspect "$name" >/dev/null 2>&1; then
    return
  fi
  if [ "$tls" = "on" ]; then
    docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" -v "$out:/certs:ro" \
      -p "127.0.0.1:${port}:5432" --entrypoint bash "$image" -c \
      'cp /certs/server.crt /certs/server.key /certs/pg_hba.conf /tmp/ && chown postgres /tmp/server.crt /tmp/server.key /tmp/pg_hba.conf && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key -c hba_file=/tmp/pg_hba.conf -c max_connections=200' \
      >/dev/null
  else
    docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" \
      -p "127.0.0.1:${port}:5432" "$image" >/dev/null
  fi
  echo "started $name on 127.0.0.1:${port} (tls $tls)" >&2
}

for major in 16 17 18; do
  start "${prefix}-pg${major}" "${images[$major]}" "${base_port}${major}" on
done
start "${prefix}-plain" "${images[17]}" "${base_port}99" off

# Wait for the final servers: the image's init server listens on the socket
# only, so readiness is a TCP query (TLS where the server requires it).
for name in "${prefix}-pg16" "${prefix}-pg17" "${prefix}-pg18" "${prefix}-plain"; do
  for _ in $(seq 1 90); do
    docker exec -e PGPASSWORD="$password" "$name" \
      psql -h 127.0.0.1 -U postgres -tAc 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
  done
done

cat >"$out/targets.json" <<JSON
{
  "serverName": "${server_name}",
  "caFile": "${out}/ca.crt",
  "otherCaFile": "${out}/other-ca.crt",
  "serverCertFile": "${out}/server.crt",
  "serverKeyFile": "${out}/server.key",
  "superuser": "postgres",
  "passwordFile": "${out}/superuser",
  "servers": [
    { "major": 16, "host": "127.0.0.1", "port": ${base_port}16, "container": "${prefix}-pg16" },
    { "major": 17, "host": "127.0.0.1", "port": ${base_port}17, "container": "${prefix}-pg17" },
    { "major": 18, "host": "127.0.0.1", "port": ${base_port}18, "container": "${prefix}-pg18" }
  ],
  "plaintext": { "major": 17, "host": "127.0.0.1", "port": ${base_port}99 }
}
JSON
chmod 600 "$out/targets.json"
echo "export EXDB_TEST_TARGETS=\"${out}/targets.json\""
