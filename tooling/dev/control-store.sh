#!/usr/bin/env bash
# Starts a disposable PostgreSQL 17 container for local development and the
# integration tests (local-development.md). Development only: never point
# EXDB_TEST_PG_URL or any ExponetDB variable at a shared or production server.
set -euo pipefail
name="${EXDB_DEV_PG_CONTAINER:-exdb-control}"
port="${EXDB_DEV_PG_PORT:-55432}"
image="postgres:17"
if ! docker inspect "$name" >/dev/null 2>&1; then
  password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  docker run -d --name "$name" -e POSTGRES_PASSWORD="$password" \
    -p "127.0.0.1:${port}:5432" "$image" >/dev/null
  umask 077
  printf '%s\n' "$password" > ".exdb-dev-superuser"
  echo "started $name on 127.0.0.1:${port}; superuser password in ./.exdb-dev-superuser (git-ignored)"
fi
for _ in $(seq 1 30); do
  docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
echo "export EXDB_TEST_PG_URL=\"postgres://postgres:\$(cat .exdb-dev-superuser)@127.0.0.1:${port}/postgres\""
