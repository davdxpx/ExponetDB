#!/usr/bin/env bash
# Plan created by the OLD release, applied by the NEW one: does the changed policy version make it stale? (brief: "policy version changed:
# plans made before are stale: confirm"). Restores the pre-upgrade dump (old schema) to get an old-release Control Store back, plans on a
# fresh target, upgrades (third time: 40-upgrade.sh up3), applies the old plan, compares policy versions.
. /srv/work/s3-infra/s3/lib.sh
OUT="${S3_LOGS}/policyver"; mkdir -p "$OUT"
for r in serve worker gateway; do systemctl stop "$(_stk_unit $r)" 2>/dev/null; done
cs_wipe >/dev/null 2>&1; cs_restore "${EXSTACK_STATE}/dumps/control-pre-upgrade.sql.gz" || exit 1
s3_release old; s3_units old
for r in worker gateway serve; do systemctl start "$(_stk_unit $r)"; done
for i in $(seq 1 90); do stack_ready && break; sleep 1; done; echo "old release back on the restored old-schema store: $(cs_status 2>&1 | jq -c '{status,expected,applied}'), serve ready $(stack_ready && echo yes)"
echo "CLI after the restore (tokens rotated after the dump are unknown to the restored store): $(exdb whoami 2>&1 | head -1 | cut -c1-100); target list: $(exdb target list 2>&1 | head -1 | cut -c1-100)"
cli_login >/dev/null 2>&1 && echo "signed in again (cli_login: one consent round trip)"
T="$(add_target "s3pv$(date +%H%M)" pg17 2>/dev/null)"; d="$(new_project pv)"
mkb "$d" policy-probe <<<"CREATE TABLE public.pv_probe (id int PRIMARY KEY); GRANT SELECT ON public.pv_probe TO lab_owner;" >/dev/null
mplan "$d" "$T"; PV_PLAN="$PLAN_ID"
echo "plan $PV_PLAN created by d0229550: policy_version=$(ctl_sql "select policy_version from operations.plans where plan_id='$PV_PLAN'")"
echo "$PV_PLAN" >"$OUT/plan.id"
bash "${S3_DIR}/40-upgrade.sh" up3 2>&1 | tail -9
s3_release new
echo "== plan $PV_PLAN after the upgrade: state $(ctl_sql "select state from operations.plans where plan_id='$PV_PLAN'"), a plan of the same kind made now would carry the policy version:"
d2="$(new_project pv2)"; mkb "$d2" policy-probe2 <<<"CREATE TABLE public.pv_probe2 (id int PRIMARY KEY); GRANT SELECT ON public.pv_probe2 TO lab_owner;" >/dev/null
mplan "$d2" "$T" >/dev/null; echo "  new-release plan $PLAN_ID: policy_version=$(ctl_sql "select policy_version from operations.plans where plan_id='$PLAN_ID'")"
exdb_json plan withdraw "$PLAN_ID" >/dev/null 2>&1
j="$(exdb_json plan apply "$PV_PLAN" --no-wait --yes)"; OPA="$(jq -r '.operationId // .data.operationId // .data.id // empty' <<<"$j")"
echo "== apply of the old plan: error=$(jq -r '.error.code // "none"' <<<"$j") op=${OPA:-none}"
for i in $(seq 1 30); do s="$( [ -n "$OPA" ] && op_state "$OPA")"; case "${s%% *}" in succeeded|failed|needs_attention) break;; esac; sleep 1; done
echo "   operation: $s"
