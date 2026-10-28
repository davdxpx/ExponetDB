#!/usr/bin/env bash
# Role-start smoke test of the image (G2: three process roles from one
# image). Bootstraps a disposable PostgreSQL 17 with the image's own
# bootstrap SQL, migrates it, starts serve, worker and gateway from the same
# image with their own logins, waits for Docker to report them healthy,
# probes serve (probes, the Web App with its CSP, the API refusing without a
# session), issues the first-owner setup link from the image, then stops the
# roles with SIGTERM and requires a clean exit.
# Everything runs on a private Docker network; nothing is published except
# serve's probe port on loopback. Usage: tooling/smoke/roles.sh <image>
set -euo pipefail
image="${1:?usage: roles.sh <image>}"
pg_image="postgres:17.11@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f"
run_id="exdb-smoke-$$"
net="$run_id"
work="$(mktemp -d)"
chmod 0700 "$work"
cleanup() {
  docker rm -f "$run_id-pg" "$run_id-serve" "$run_id-worker" "$run_id-gateway" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
as_me=(--user "$(id -u):$(id -g)" -v "$work:/work")

docker network create "$net" >/dev/null
superuser_password="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
docker run -d --name "$run_id-pg" --network "$net" -e POSTGRES_PASSWORD="$superuser_password" "$pg_image" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$run_id-pg" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

echo "== bootstrap SQL from the image (verifiers only), applied by the superuser"
docker run --rm "${as_me[@]}" "$image" control-store bootstrap-sql \
  --credentials-file /work/credentials --output /work/bootstrap.sql
serve_password="$(sed -n 's/^exdb_serve=//p' "$work/credentials")"
[ -n "$serve_password" ] || { echo "no exdb_serve password in the credentials file" >&2; exit 1; }
# -F --: the password is a fixed string and may start with "-".
if grep -qF -- "$serve_password" "$work/bootstrap.sql"; then
  echo "bootstrap SQL contains a password" >&2
  exit 1
fi
docker exec -i "$run_id-pg" psql -q -U postgres -v ON_ERROR_STOP=1 -d postgres < "$work/bootstrap.sql"
url() { echo "postgres://$1:$(sed -n "s/^$1=//p" "$work/credentials")@$run_id-pg:5432/exponetdb_control"; }

echo "== migrate (one-shot, exdb_migrate)"
docker run --rm --network "$net" -e EXPONETDB_CONTROL_STORE_URL="$(url exdb_migrate)" -e EXPONETDB_LOG_LEVEL=warn \
  "$image" control-store migrate > "$work/migrate.json"
installation="$(sed -n 's/.*"installationId": "\(ins_[0-9A-Z]*\)".*/\1/p' "$work/migrate.json" | head -1)"
grep -q '"status": "current"' "$work/migrate.json"
echo "installation $installation"

echo "== keyring"
docker run --rm "${as_me[@]}" "$image" keyring generate --key-id smoke1 --output /work/keyring.json
keyring="$(cat "$work/keyring.json")"

start_role() {
  local role="$1" login="$2"
  shift 2
  docker run -d --name "$run_id-$role" --network "$net" \
    -e EXPONETDB_CONTROL_STORE_URL="$(url "$login")" \
    -e EXPONETDB_INSTALLATION_ID="$installation" \
    -e EXPONETDB_KEYRING="$keyring" \
    "$@" "$image" "$role" >/dev/null
}
start_role serve exdb_serve -p 127.0.0.1:18080:8080 -e EXPONETDB_PUBLIC_URL=http://localhost:18080
start_role worker exdb_worker
start_role gateway exdb_gateway

echo "== waiting for health"
for role in serve worker gateway; do
  status=starting
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$run_id-$role")"
    [ "$status" = healthy ] && break
    sleep 2
  done
  echo "$role: $status"
  if [ "$status" != healthy ]; then
    docker logs "$run_id-$role" >&2
    exit 1
  fi
done

echo "== serve probes"
curl -fsS http://127.0.0.1:18080/healthz/ready
echo
# Wave 4, Wave 5 and Wave 9 Part B routes are served and need authentication; a route that is
# contracted but not served (the ledger reconciliation plan) answers 404.
for path in targets nodes clusters/cls_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/backups backups/overview; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18080/api/v1/$path")"
  [ "$code" = 401 ] || { echo "/api/v1/$path without credentials answered $code" >&2; exit 1; }
done
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  http://127.0.0.1:18080/api/v1/targets/tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/ledger/not-a-route)"
[ "$code" = 404 ] || { echo "an unserved route answered $code" >&2; exit 1; }
# The ledger reconciliation plan has been served since TC-007: without a session a served mutating
# route answers 403 (the CSRF check comes first), not the 404 of a path nobody serves.
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  http://127.0.0.1:18080/api/v1/targets/tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/ledger/reconcile-plans)"
[ "$code" = 403 ] || { echo "the served reconcile-plans route answered $code" >&2; exit 1; }
# Wave 7: /mcp is served; without a token it answers 401 with the challenge naming its metadata.
curl -s -o /dev/null -D "$work/mcp.headers" -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:18080/mcp > "$work/mcp.code"
[ "$(cat "$work/mcp.code")" = 401 ] || { echo "/mcp without a token answered $(cat "$work/mcp.code")" >&2; exit 1; }
grep -qi '^www-authenticate: Bearer .*resource_metadata="[^"]*/.well-known/oauth-protected-resource/mcp"' "$work/mcp.headers" \
  || { echo "/mcp answered 401 without its resource metadata challenge" >&2; exit 1; }

echo "== Web App and API"
curl -fsS -D "$work/login.headers" -o "$work/login.html" http://127.0.0.1:18080/login
grep -qi "^content-security-policy: default-src 'none'; script-src 'self'" "$work/login.headers" \
  || { echo "the Web App is served without its CSP" >&2; exit 1; }
grep -qi '^cache-control: no-store' "$work/login.headers" || { echo "the Web App is cacheable" >&2; exit 1; }
grep -q '/assets/app.js' "$work/login.html" || { echo "the Web App page is missing" >&2; exit 1; }
curl -fsS -o /dev/null http://127.0.0.1:18080/assets/app.js
grep -qi "style-src 'self'" "$work/login.headers" && ! grep -qi 'unsafe-' "$work/login.headers" \
  || { echo "the Web App CSP allows inline or evaluated code" >&2; exit 1; }
# Wave 8: client routes answer with the page; unknown API paths stay NOT_FOUND problems.
curl -fsS -o "$work/route.html" http://127.0.0.1:18080/t/example/app/staging/schema
cmp -s "$work/route.html" "$work/login.html" || { echo "a client route did not answer with the page" >&2; exit 1; }
code="$(curl -s -o "$work/unknown.json" -w '%{http_code}' http://127.0.0.1:18080/api/v1/no-such-resource)"
[ "$code" = 404 ] && grep -q '"code":"NOT_FOUND"' "$work/unknown.json" \
  || { echo "an unknown API path answered $code without a NOT_FOUND problem" >&2; exit 1; }
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/v1/me)"
  [ "$code" = 401 ] && break
  sleep 1
done
[ "$code" = 401 ] || { echo "/api/v1/me without a session answered $code" >&2; exit 1; }

echo "== first-owner setup link from the image (standard output only)"
docker run --rm --network "$net" -e EXPONETDB_CONTROL_STORE_URL="$(url exdb_serve)" \
  -e EXPONETDB_PUBLIC_URL=http://localhost:18080 -e EXPONETDB_LOG_LEVEL=warn \
  "$image" bootstrap owner --email owner@example.test > "$work/owner.json"
grep -q '"setupLink": "http://localhost:18080/setup#token=exsu_' "$work/owner.json" \
  || { echo "bootstrap owner did not print a setup link" >&2; exit 1; }
token="$(sed -n 's/.*#token=\(exsu_[A-Za-z0-9_-]*\).*/\1/p' "$work/owner.json")"
[ -n "$token" ] || { echo "no setup token in the command output" >&2; exit 1; }

echo "== graceful shutdown"
for role in serve worker gateway; do
  docker stop -t 30 "$run_id-$role" >/dev/null
  exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$run_id-$role")"
  echo "$role exit $exit_code"
  [ "$exit_code" = 0 ] || { docker logs "$run_id-$role" >&2; exit 1; }
  if docker logs "$run_id-$role" 2>&1 | grep -qE 'postgres://|SCRAM-SHA-256|"key":|exs[tu]_|exck_'; then
    echo "$role logged secret material" >&2
    exit 1
  fi
  if docker logs "$run_id-$role" 2>&1 | grep -qF -- "$token"; then
    echo "$role logged the setup token" >&2
    exit 1
  fi
done
echo "smoke test passed: three roles from $image"
