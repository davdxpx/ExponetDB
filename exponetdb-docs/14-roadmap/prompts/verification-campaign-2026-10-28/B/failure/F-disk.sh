#!/usr/bin/env bash
# Disk full during an apply, on the TARGET and on the CONTROL STORE (brief, block B, failure injection).
#
#   F-disk.sh target     a 24 MB loop-mounted filesystem holds a tablespace; the target database's default_tablespace is that
#                        tablespace, so the bundle's CREATE TABLE ... AS SELECT (about 100 MB) hits ENOSPC mid-statement.
#                        tx bundle: expected failed, not_applied, nothing left; nontx bundle: documented partial state.
#   F-disk.sh control    the Control Store's data directory moves onto a 400 MB loop filesystem which is then filled to the brim
#                        (WAL cannot extend). Observed: what serve/worker/the CLI say, what stops, how recovery looks after space
#                        is freed. The data stays on the loop filesystem until stack-down (which unmounts it).
# Loop filesystems live under $EXSTACK_ROOT/loop (stack-down unmounts everything below $EXSTACK_ROOT).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PG=pg16; LOOP="${EXSTACK_ROOT}/loop"; mkdir -p "$LOOP"
OUT="${S1_LOGS}/F"; mkdir -p "$OUT"

disk_target() {
  local img="${LOOP}/target.img" mnt="${LOOP}/target"
  mkdir -p "$mnt"; mountpoint -q "$mnt" && umount "$mnt"
  dd if=/dev/zero of="$img" bs=1M count=24 status=none && mkfs.ext4 -q -F "$img" && mount -o loop "$img" "$mnt"
  mkdir -p "$mnt/ts" && chown postgres:postgres "$mnt/ts" && chmod 700 "$mnt/ts"
  psql_target "$PG" -q -c "DROP TABLESPACE IF EXISTS exs_small" 2>/dev/null
  psql_target "$PG" -q -c "CREATE TABLESPACE exs_small LOCATION '${mnt}/ts'" || { verdict F.disk_target NOT_RUN "tablespace not created"; return; }
  local kind T db dir id op
  for kind in tx nontx; do
    T="$(fresh_target "dsk${kind}" "$PG")"; db="$(target_db "$T")"; dir="$(new_project "disk-${kind}-${RUN_TAG}")"
    PGDATABASE=postgres psql_target "$PG" -q -c "ALTER DATABASE ${db} SET default_tablespace = exs_small"
    local flags=(); [ "$kind" = nontx ] && flags=(--nontransactional)
    id="$(mkb "$dir" "fill-${kind}" "${flags[@]}" <<'SQL'
CREATE TABLE public.small_one (id int PRIMARY KEY);
CREATE TABLE public.big AS SELECT g AS id, repeat('x', 400) AS pad FROM generate_series(1, 300000) g;
GRANT SELECT ON public.small_one, public.big TO lab_owner;
SQL
)"
    mplan "$dir" "$T" || { verdict "F.disk_target_${kind}" NOT_RUN "plan: ${PLAN_STATE}"; continue; }
    mapply "$PLAN_ID" --wait; op="$OP_ID"
    local led tabs; led="$(ledger_count "$PG" "$db" "$id")"; tabs="$(tables_in "$PG" "$db")"
    local detail; detail="$(exdb_json operation show "$op" | jq -r '[.data.errorCode, (.data.migrations[0].error // .data.migrations[0].errorCode // "")|tostring] | join(" ")')"
    echo "[${kind}] op=[$(op_state "$op")] ledger=${led} objects=[${tabs}] error: ${detail}; target filesystem: $(df -h "$mnt" | tail -1 | awk '{print $5" used"}')"
    local ok=PASS
    if [ "$kind" = tx ]; then { [ "$led" = 0 ] && [ "$tabs" = "-" ]; } || ok=FAIL; else { [ "$led" = 0 ]; } || ok=FAIL; [ "$ok" = PASS ] && ok=PARTIAL; fi
    case "$(op_state "$op" | cut -d' ' -f1)" in succeeded) ok=FAIL ;; esac
    verdict "F.disk_target_${kind}" "$ok" "$(op_state "$op" | sed 's/ kind=.*//'); ledger=${led}; objects=[${tabs}]; ${detail}"
    PGDATABASE=postgres psql_target "$PG" -q -c "ALTER DATABASE ${db} RESET default_tablespace"
    # the target is usable after the failure
    mkb "$dir" "after-${kind}" >/dev/null <<'SQL'
CREATE TABLE public.after_full (id int PRIMARY KEY);
GRANT SELECT ON public.after_full TO lab_owner;
SQL
    mplan "$dir" "$T" >/dev/null 2>&1 && { mapply "$PLAN_ID" --wait >/dev/null 2>&1; echo "[${kind}] a following change: $(op_state "$OP_ID" | cut -d' ' -f1)"; } || echo "[${kind}] a following plan: ${PLAN_STATE:-?}"
  done
}

disk_control() {
  local img="${LOOP}/control.img" mnt="${LOOP}/control-mount" data="${EXSTACK_CONTROL_DATA}"
  mkdir -p "$mnt"
  echo "control-data size: $(du -sh "$data" | cut -f1)"
  # move the data onto the loop filesystem
  docker stop -t 30 "${EXSTACK_CONTROL_NAME}" >/dev/null
  dd if=/dev/zero of="$img" bs=1M count=400 status=none && mkfs.ext4 -q -F "$img" && mount -o loop "$img" "$mnt"
  rsync -a "${data}/" "${mnt}/" && umount "$mnt" && mv "$data" "${data}.old" && mkdir "$data" && mount -o loop "$img" "$data"
  docker start "${EXSTACK_CONTROL_NAME}" >/dev/null; _stk_wait_control
  restart_cp
  echo "free on the Control Store filesystem: $(df -h "$data" | tail -1 | awk '{print $4}')"
  exdb target list >/dev/null && echo "baseline: target list works"
  # fill it: leave 256 KiB
  local avail; avail=$(( $(df --output=avail -B1 "$data" | tail -1) - 262144 ))
  fallocate -l "$avail" "${data}/filler" 2>/dev/null || dd if=/dev/zero of="${data}/filler" bs=1M count=$(( avail / 1048576 )) status=none
  echo "filled: free now $(df -h "$data" | tail -1 | awk '{print $4}')"
  local dir T; dir="$(new_project "disk-control-${RUN_TAG}")"
  mkb "$dir" "ctl-full" >/dev/null <<'SQL'
CREATE TABLE public.ctl_full (id int PRIMARY KEY);
GRANT SELECT ON public.ctl_full TO lab_owner;
SQL
  echo "--- while the Control Store disk is full"
  echo "stack: $(stack_ready && echo serve-ready || echo serve-NOT-ready); control container: $(docker inspect -f '{{.State.Status}}' "${EXSTACK_CONTROL_NAME}")"
  echo "plan: $(cd "$dir" && exdb_json migration plan --target lab/platform/staging | jq -c '{s:.status, e:.error.code, m:(.error.message|.[0:100])}')"
  echo "read: $(exdb_json target list | jq -c '{s:.status, e:.error.code, n:(.data.items|length?)}')"
  sleep 20
  echo "after 20 s: container $(docker inspect -f '{{.State.Status}}' "${EXSTACK_CONTROL_NAME}") restarts=$(docker inspect -f '{{.RestartCount}}' "${EXSTACK_CONTROL_NAME}"); postgres log tail:"
  docker logs --tail 6 "${EXSTACK_CONTROL_NAME}" 2>&1 | cut -c1-180
  echo "roles: $(for r in serve worker gateway; do printf '%s=%s ' $r "$(systemctl is-active "$(_stk_unit $r)")"; done); readiness: $(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${EXSTACK_PORT_INTERNAL_SERVE}/healthz/ready")"
  echo "--- free the space and recover"
  rm -f "${data}/filler"; docker start "${EXSTACK_CONTROL_NAME}" >/dev/null 2>&1; _stk_wait_control; sleep 5
  restart_cp
  echo "after freeing: plan: $(cd "$dir" && exdb_json migration plan --target lab/platform/staging | jq -c '{s:.status, e:.error.code}'); read: $(exdb_json target list | jq -c '{s:.status}')"
  verdict F.disk_control PARTIAL "see the log: Control Store at 100% disk; observations above (what stopped, what said what, recovery after freeing space)"
}

for c in "${@:-target control}"; do for t in $c; do ( "disk_${t}" ) 2>&1 | tee "${OUT}/disk-${t}.log"; done; done
