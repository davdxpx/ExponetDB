#!/usr/bin/env bash
# The only real way back: stop everything, restore the pg_dumpall taken before the migration into an empty PostgreSQL 17
# (control-store-runbook.md RB-10 step 2), check it (steps 3, 4), start the OLD build (step 5), and time every step.
# Run after 60-rollback-documented.sh (the roles are down). Usage: 65-rollback-restore.sh [dump-label]
. /srv/work/s3-infra/s3/lib.sh
LABEL="${1:-pre-upgrade}"; DUMP="${EXSTACK_STATE}/dumps/control-${LABEL}.sql.gz"
OUT="${S3_LOGS}/rollback-restore"; mkdir -p "$OUT"
s3_release old
bash "${S3_DIR}/counts.sh" prerestore preup >/dev/null 2>&1 || true   # (store is the migrated one; census for the "what did the restore throw away" diff)
cp "${S3_LOGS}/census/prerestore.counts.tsv" "$OUT/" 2>/dev/null
sampler_start "${OUT}/sampler.log"; sleep 0.5
R0=$(epoch_ms); say "rollback by restore starts (dump ${LABEL}, $(stat -c %s "$DUMP") bytes)"
for r in serve worker gateway; do systemctl stop "$(_stk_unit $r)" 2>/dev/null; done
t=$(epoch_ms); cs_wipe; timing rollback "cs_wipe (rm container+data, new empty PG17 with restore_admin)" "$(( $(epoch_ms) - t ))"
t=$(epoch_ms); cs_restore "$DUMP"; rc=$?; timing rollback "cs_restore (psql ON_ERROR_STOP)" "$(( $(epoch_ms) - t ))" "rc=$rc"
t=$(epoch_ms); st="$(cs_status 2>&1)"; timing rollback "control-store status (old build)" "$(( $(epoch_ms) - t ))"; echo "status: $(jq -c '{status,expected,applied,installationId}' <<<"$st" 2>/dev/null || echo "$st" | head -3)"
t=$(epoch_ms); v="$(ro audit verify 2>&1)"; timing rollback "audit verify (old build)" "$(( $(epoch_ms) - t ))"; echo "audit verify: $(jq -c . <<<"$v" 2>/dev/null || echo "$v" | head -3)"
t=$(epoch_ms); k="$( ( set -a; . "${EXSTACK_STATE}/env/operator-worker.env"; set +a; node_run keyring status ) 2>&1 | jq -c '{active: .activeKeyId, missing, mismatched}' 2>/dev/null)"; timing rollback "keyring status" "$(( $(epoch_ms) - t ))"; echo "keyring: $k"
s3_units old
t=$(epoch_ms)
for r in worker gateway serve; do systemctl start "$(_stk_unit $r)"; done
for i in $(seq 1 300); do stack_ready && break; sleep 0.2; done
timing rollback "start old roles to serve ready" "$(( $(epoch_ms) - t ))"
R1=$(epoch_ms); timing rollback "TOTAL decision to old release ready" "$((R1 - R0))"
sleep 3; sampler_stop
echo "total $((R1 - R0)) ms"; role_versions
echo "--- the owner's sessions after the restore"
exdb whoami 2>&1 | head -4
