#!/usr/bin/env bash
# RB-10 "Control Store down" (control-store-runbook.md section 4), executed AS WRITTEN with only the offline kit (/srv/work/s3/offline):
# the dump, the credentials file, the keyring, the checkpoint bucket. Every action is a numbered operator step; "runbook" says whether the
# document names it (Y), names it vaguely (V) or leaves it out (N). Timed.
. /srv/work/s3-infra/s3/lib.sh
s3_release new
OFF=/srv/work/s3/offline; OUT="${S3_LOGS}/loss"; STEPLOG="${OUT}/rb10-steps.tsv"; : >"$STEPLOG"; N=0
cred() { grep "^$1=" "${OFF}/control.cred" | cut -d= -f2-; }      # the offline credentials file, not the dead system's state
step() { N=$((N + 1)); S_T0=$(epoch_ms); S_DESC="$2"; S_DOC="$1"; printf '\n[step %d, runbook=%s] %s\n' "$N" "$1" "$2"; }
endstep() { local ms=$(( $(epoch_ms) - S_T0 )); printf '%d\t%s\t%s\t%d\t%s\n' "$N" "$S_DOC" "$S_DESC" "$ms" "${1:-}" >>"$STEPLOG"; printf '  -> %d ms %s\n' "$ms" "${1:-}"; }
R0=$(epoch_ms)

step Y "RB-10.1 triage: is the resource running? disk? network? login refused?"
docker ps -a --filter name="${EXSTACK_CONTROL_NAME}" --format '{{.Names}} {{.Status}}' | head -2; df -h /srv | tail -1; echo "(resource absent; roles: $(for r in serve worker gateway; do printf '%s=%s ' $r "$(systemctl is-active "$(_stk_unit $r)")"; done))"; endstep

step Y "RB-10.2a new isolated PostgreSQL 17 resource, maintenance database postgres, temporary superuser restore_admin"
docker rm -f "${EXSTACK_CONTROL_NAME}" >/dev/null 2>&1; rm -rf "${EXSTACK_CONTROL_DATA}"   # a failed first attempt (see NOTES) leaves a half-restored server: start over
control_container_start "${SUPER:-restore_admin}" && echo "up (superuser ${SUPER:-restore_admin})"; endstep "(a new Coolify resource also gets a NEW host name: the roles' URLs change, see step 9)"

step V "RB-10.2b decompress the export and feed it to psql -U restore_admin -d postgres -v ON_ERROR_STOP=1 inside the scratch resource"
cs_restore "${OFF}/control-dump.sql.gz"; rc=$?; endstep "rc=$rc"

step Y "RB-10.2c control-store status with a restored runtime login (exdb_serve, password from the offline credentials file): installation ID must match, every bundle applied and verified"
st="$(EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(printf 'postgres://exdb_serve:%s@127.0.0.1:%s/exponetdb_control' "$(urlenc "$(cred exdb_serve)")" "${EXSTACK_PORT_CONTROL}")" node_run control-store status 2>&1)"
echo "$st" | jq -c . 2>/dev/null || echo "$st"; echo "installation id expected by the roles: $(cat "${EXSTACK_STATE}/installation_id")"; endstep

step Y "RB-10.2d later release's additive bundles through control-store migrate (exdb_migrate): none needed, status is current"
endstep "(skipped: same release)"

step Y "RB-10.3a integrity: audit verify (full chain)"
v="$(EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(printf 'postgres://exdb_serve:%s@127.0.0.1:%s/exponetdb_control' "$(urlenc "$(cred exdb_serve)")" "${EXSTACK_PORT_CONTROL}")" node_run audit verify 2>&1)"; echo "$v" | jq -c . 2>/dev/null || echo "$v"; endstep

step V "RB-10.3b compare the newest exported checkpoint in the bucket with the restored chain: audit verify --from-checkpoint <seq>"
ls "${OFF}/audit-export"/*/audit-checkpoints/ | tail -3; newest="$(ls "${OFF}/audit-export"/*/audit-checkpoints/ | sed 's/\.json//' | sort | tail -1 | sed 's/^0*//')"
echo "newest exported checkpoint seq: ${newest}; the dump's last audit seq: $(cat ${OUT}/dump-seq.txt | awk '{print $NF}')"
v="$(EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(printf 'postgres://exdb_serve:%s@127.0.0.1:%s/exponetdb_control' "$(urlenc "$(cred exdb_serve)")" "${EXSTACK_PORT_CONTROL}")" node_run audit verify --from-checkpoint "${newest}" 2>&1)"; echo "$v" | jq -c . 2>/dev/null || echo "$v"; endstep

step N "RB-10.3c record the gap (events after the dump are lost): how many? the runbook says the exported checkpoints show its size"
echo "events written after the dump (known only because the lab wrote them): $(awk -F'[ >()]+' '/written after the backup/ {print $0}' ${S3_LOGS}/loss-00-prepare.out | head -1)"; endstep "(checkpoints are hourly: newest is seq ${newest}, the gap cannot be sized from them)"

step Y "RB-10.4 keyring status with the offline keyring: no missing key"
k="$(EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(printf 'postgres://exdb_worker:%s@127.0.0.1:%s/exponetdb_control' "$(urlenc "$(cred exdb_worker)")" "${EXSTACK_PORT_CONTROL}")" EXPONETDB_KEYRING="$(jq -c . "${OFF}/keyring.json")" node_run keyring status 2>&1)"; echo "$k" | jq -c '{activeKeyId, keys: [.keys[]|{keyId,status,references}], missing, mismatched}' 2>/dev/null || echo "$k"; endstep

step V "RB-10.5a roles: 'Update EXPONETDB_CONTROL_STORE_URL of each resource if the passwords changed' - same dump, same SCRAM verifiers: unchanged; host/port unchanged in the lab"
endstep "(in Coolify the new resource has a new host name: every role's URL changes)"

step Y "RB-10.5b start worker, serve, gateway - they were left running: do they recover by themselves (no restart)?"
for i in $(seq 1 90); do stack_ready && break; sleep 1; done; echo "serve ready after waiting: $(stack_ready && echo yes || echo no) ($i s)"; role_versions; endstep
