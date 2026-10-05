#!/usr/bin/env bash
# Starts disposable containers for local development and the integration
# tests (local-development.md): PostgreSQL 17 for the Control Store and an
# S3-compatible server (versitygw) for the audit checkpoint export. Development
# only: never point EXDB_TEST_* or any ExponetDB variable at a shared or
# production server. Images are pinned by digest, as in CI.
set -euo pipefail
pg_name="${EXDB_DEV_PG_CONTAINER:-exdb-control}"
pg_port="${EXDB_DEV_PG_PORT:-55432}"
pg_image="postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f"
s3_name="${EXDB_DEV_S3_CONTAINER:-exdb-s3}"
s3_port="${EXDB_DEV_S3_PORT:-57070}"
s3_image="versity/versitygw:v1.8.0@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499"
umask 077
random() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32; }

if ! docker inspect "$pg_name" >/dev/null 2>&1; then
  random > ".exdb-dev-superuser"
  docker run -d --name "$pg_name" -e POSTGRES_PASSWORD="$(cat .exdb-dev-superuser)" \
    -p "127.0.0.1:${pg_port}:5432" "$pg_image" >/dev/null
  echo "started $pg_name on 127.0.0.1:${pg_port}; superuser password in ./.exdb-dev-superuser (git-ignored)" >&2
fi
if ! docker inspect "$s3_name" >/dev/null 2>&1; then
  random > ".exdb-dev-s3-secret"
  docker run -d --name "$s3_name" -e ROOT_ACCESS_KEY=exdbtest \
    -e ROOT_SECRET_KEY="$(cat .exdb-dev-s3-secret)" --tmpfs /data \
    -p "127.0.0.1:${s3_port}:7070" "$s3_image" --port :7070 posix /data >/dev/null
  echo "started $s3_name on 127.0.0.1:${s3_port}; secret key in ./.exdb-dev-s3-secret (git-ignored)" >&2
fi
for _ in $(seq 1 30); do
  docker exec "$pg_name" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
cat <<VARS
export EXDB_TEST_PG_URL="postgres://postgres:\$(cat .exdb-dev-superuser)@127.0.0.1:${pg_port}/postgres"
export EXDB_TEST_S3_ENDPOINT="http://127.0.0.1:${s3_port}"
export EXDB_TEST_S3_ACCESS_KEY="exdbtest"
export EXDB_TEST_S3_SECRET_KEY="\$(cat .exdb-dev-s3-secret)"
VARS
