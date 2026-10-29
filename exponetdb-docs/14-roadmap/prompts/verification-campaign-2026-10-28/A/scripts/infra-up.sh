#!/bin/bash
# Replicates the CI steps: PG17 control store, versitygw S3, the managed-target servers. Writes /srv/work/infra.env
source /srv/work/env.sh
set -u
N=/srv/work/new
docker rm -f exdb-pg17 exdb-s3 >/dev/null 2>&1
for v in 16 17 18; do docker rm -f exdb-target-pg$v >/dev/null 2>&1; done
docker ps -a --format '{{.Names}}' | grep -E '^exdb-' | xargs -r docker rm -f >/dev/null 2>&1
rm -rf /srv/work/exdb-targets
umask 077
password="$(openssl rand -hex 24)"
docker run -d --name exdb-pg17 -e POSTGRES_PASSWORD="$password" -p 127.0.0.1:55432:5432 \
  postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f >/dev/null
for _ in $(seq 1 90); do
  docker exec exdb-pg17 psql -h 127.0.0.1 -U postgres -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec exdb-pg17 psql -h 127.0.0.1 -U postgres -tAc 'SELECT version()'
mode="${1:-full}"
if [ "$mode" = "pg" ]; then
  printf 'export EXDB_TEST_PG_URL=postgres://%s:%s@127.0.0.1:55432/postgres\n' postgres "$password" > /srv/work/infra.env
  chmod 600 /srv/work/infra.env
  docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | sed 's/@sha256:[0-9a-f]*//'
  exit 0
fi
secret="$(openssl rand -hex 24)"
docker run -d --name exdb-s3 -e ROOT_ACCESS_KEY=exdbtest -e ROOT_SECRET_KEY="$secret" --tmpfs /data -p 127.0.0.1:57070:7070 \
  versity/versitygw:v1.8.0@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499 --port :7070 posix /data >/dev/null
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:57070/ && break; sleep 1; done
cd $N && bash tooling/dev/targets.sh /srv/work/exdb-targets > /srv/work/targets.out 2>&1
{
  printf 'export EXDB_TEST_PG_URL=postgres://%s:%s@127.0.0.1:55432/postgres\n' postgres "$password"
  echo "export EXDB_TEST_S3_ENDPOINT=http://127.0.0.1:57070"
  echo "export EXDB_TEST_S3_ACCESS_KEY=exdbtest"
  echo "export EXDB_TEST_S3_SECRET_KEY=$secret"
  echo "export EXDB_TEST_TARGETS=/srv/work/exdb-targets/targets.json"
} > /srv/work/infra.env
chmod 600 /srv/work/infra.env
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' | sed 's/@sha256:[0-9a-f]*//'
