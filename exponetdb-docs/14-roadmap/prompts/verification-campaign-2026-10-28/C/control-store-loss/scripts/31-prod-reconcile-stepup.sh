#!/usr/bin/env bash
# Production ledger reconcile after a restore: the operator's whole path with the CLI (text mode shows the step-up address and code;
# `--json --yes` waits silently for it, which is how the first attempt hung for 7 minutes), the person's re-authentication (software passkey
# of the lab) and approval, with every step counted.
. /srv/work/s3-infra/s3/lib.sh
s3_release new
T=lab/platform/production; OUT="${S3_LOGS}/loss"; N=0; t0=$(epoch_ms)
st() { N=$((N + 1)); printf 'step %d (+%d ms): %s\n' "$N" "$(( $(epoch_ms) - t0 ))" "$*"; }
dir="$(new_project cycle-rec2)"
mkb "$dir" cycle-p5 <<<"CREATE TABLE public.cycle_p5 (id int PRIMARY KEY); GRANT SELECT ON public.cycle_p5 TO lab_owner;" >/dev/null
st "migration status: $(cd $dir && exdb_json migration status --target $T | jq -c .data.mirror)"
st "migration plan (a new change): $(cd $dir && exdb migration plan --target $T 2>&1 | head -1)"
j="$(exdb_json migration ledger reconcile --target $T --note 'Control Store restored from dump 2; production applied cycle-p3 after it')"; RP="$(jq -r '.data.id // empty' <<<"$j")"
st "migration ledger reconcile -> plan $RP decision=$(jq -r '.data.decision' <<<"$j") class=$(jq -r '.data.class' <<<"$j") requirements=$(jq -c '[.data.requirements[]? | {kind, count, withinSeconds}]' <<<"$j")"
jq -c '.data.change.content | {decision, expectedState: (.expectedState | keys)}' <<<"$j" | cut -c1-300
LOG="$OUT/prod-reconcile-cli.out"; : >"$LOG"
( EXPONETDB_CONFIG_DIR="${EXSTACK_STATE}/cli" timeout 120 node --liftoff-only "$EXSTACK_CLI_BIN" plan apply "$RP" --yes --no-wait >"$LOG" 2>&1; echo "cli exit $?" >>"$LOG" ) &
for i in $(seq 1 40); do grep -q 'step-up#id=' "$LOG" && break; sleep 0.5; done
SID="$(grep -o 'step-up#id=[A-Za-z0-9_]*' "$LOG" | head -1 | cut -d= -f2)"; CODE="$(grep -o 'Code: [A-Z0-9-]*' "$LOG" | head -1 | awk '{print $2}')"
st "plan apply --yes (CLI) prints a step-up address and a code and waits: step-up ${SID} (code shown: ${CODE:+yes})"
st "the person re-authenticates in the Web App and confirms the step-up (scripted passkey): $(human call POST "/api/v1/step-ups/${SID}/confirm" "{\"userCode\":\"${CODE}\"}" 2>&1 | head -1 | cut -c1-160)"
for i in $(seq 1 30); do grep -q 'cli exit' "$LOG" && break; sleep 0.5; done
sed -n 5,20p "$LOG" | cut -c1-200
OPR=""; for i in $(seq 1 20); do OPR="$(psql_control -At -c "select operation_id from operations.operations where plan_id='$RP'")"; [ -n "$OPR" ] && break; sleep 0.5; done
[ -n "$OPR" ] || { echo "no operation was created"; exit 1; }
st "operation ${OPR}: $(op_state "$OPR")"
st "the person approves the operation in the Web App: $(human approve "$OPR" 2>&1 | head -1)"
for i in $(seq 1 60); do s="$(op_state "$OPR")"; case "${s%% *}" in succeeded|failed|needs_attention|canceled) break;; esac; sleep 1; done
st "operation after approval: $(op_state "$OPR")"
st "migration status: $(cd $dir && exdb_json migration status --target $T | jq -c .data.mirror)"
st "migration plan again: $(cd $dir && exdb migration plan --target $T 2>&1 | head -1)"
echo "TOTAL $N steps in $(( $(epoch_ms) - t0 )) ms; the person acted in steps with 'person' or 'approves'"
