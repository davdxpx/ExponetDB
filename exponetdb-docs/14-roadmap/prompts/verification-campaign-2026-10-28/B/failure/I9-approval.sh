#!/usr/bin/env bash
# I9 awaiting_approval: an operation that waits for an approval while its plan expires (first campaign TC-034 / OD-64) and
# the approval-window claim (findings-B1.md P2: operations-engine.md section 3.3 says an apply may wait up to 4 h, default).
#
#   I9-approval.sh create     plans (stored bundle, evidence from staging) and applies a production change from the CLI -> awaiting_approval
#   I9-approval.sh inspect    after the plan expired (30 min): what the CLI/REST show, what each exit does, then the age test
# State is kept in $S1_LOGS/approval.env (operation and plan ids only).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ENVF="${S1_LOGS}/approval.env"

create() {
  local dir id; dir="$(new_project i9ap-${RUN_TAG})"
  id="$(mkb "$dir" prod-change <<'SQL'
CREATE TABLE public.ap1 (id int PRIMARY KEY);
GRANT SELECT ON public.ap1 TO lab_owner;
SQL
)"
  mplan "$dir" lab/platform/staging && mapply "$PLAN_ID" --wait
  (cd "$dir" && exdb_json migration plan --target lab/platform/production --stored "$id") >"${S1_LOGS}/ap-plan.json"
  local plan; plan="$(jq -r '.data.id' "${S1_LOGS}/ap-plan.json")"
  echo "production plan ${plan}: decision=$(jq -r '.data.decision' "${S1_LOGS}/ap-plan.json") approvals=$(jq -c '.data.approvals' "${S1_LOGS}/ap-plan.json")"
  local out; out="$(exdb_json plan apply "$plan" --no-wait --yes)"
  local op; op="$(jq -r '.operationId // .data.operationId // .data.id' <<<"$out")"
  echo "operation ${op}: $(op_state "$op")"
  printf 'AP_OP=%s\nAP_PLAN=%s\nAP_AT=%s\n' "$op" "$plan" "$(date -u +%FT%TZ)" >"$ENVF"
  echo "plan expires at: $(ctl_sql "SELECT expires_at FROM operations.plans WHERE plan_id='${plan}'")"
}

inspect() {
  # shellcheck disable=SC1090
  . "$ENVF"
  echo "now $(date -u +%T); plan expires $(ctl_sql "SELECT expires_at FROM operations.plans WHERE plan_id='${AP_PLAN}'") ; plan state: $(ctl_sql "SELECT state FROM operations.plans WHERE plan_id='${AP_PLAN}'")"
  echo "operation: $(op_state "$AP_OP")"
  echo "--- the human's view (CLI)"
  exdb approval list 2>&1 | head -8 | cut -c1-200
  exdb approval show "$AP_OP" 2>&1 | head -16 | cut -c1-200
  local j; j="$(exdb_json operation show "$AP_OP")"
  echo "operation show: state=$(jq -r '.data.state' <<<"$j") nextAction=$(jq -c '.data.nextAction' <<<"$j") approvalUrl=$(jq -r '.data.approvalUrl != null' <<<"$j") retryable=$(jq -r '.data.retryable' <<<"$j")"
  echo "--- exits"
  local ap; ap="$(human approve "$AP_OP" 2>&1 | head -2 | tr '\n' ' ')"
  echo "approve after the plan expired: ${ap}"
  sleep 20
  echo "operation 20 s after the approval attempt: $(op_state "$AP_OP")"
  if [ "$(op_state "$AP_OP" | cut -d' ' -f1)" = awaiting_approval ]; then
    local c; c="$(exdb_json operation cancel "$AP_OP")"; echo "cancel (the applier): $(jq -c '{s:.status, e:.error.code}' <<<"$c")"
  fi
  local st; st="$(op_state "$AP_OP" | cut -d' ' -f1)"
  case "$ap" in
    *'"status":200'*) verdict I9.approval_expired_plan FAIL "the plan expired at the time shown above, the operation stayed awaiting_approval (no expiry), and an approval 15+ min after the expiry was ACCEPTED: the production change then ran (${st}). TC-034 / OD-64 stay open" ;;
    *) verdict I9.approval_expired_plan PASS "approval after the plan's expiry was refused: ${ap}; operation ${st}" ;;
  esac
}

age() { # the approval window (operations-engine.md 3.3: 4 h default): an operation older than the window
  . "$ENVF"
  echo "making the operation 25 h old (superuser UPDATE of created_at; if the guards refuse, the window test is NOT RUN)"
  if ! ctl_sql "UPDATE operations.operations SET created_at = created_at - interval '25 hours' WHERE operation_id='${AP_OP}' RETURNING operation_id" >/dev/null 2>&1; then
    verdict I9.approval_window NOT_RUN "the Control Store refuses to age the operation row ($(ctl_sql "SELECT 1" >/dev/null 2>&1; echo guard)); the window could not be simulated"; return
  fi
  local i; for i in $(seq 1 24); do sleep 5; done
  echo "operation 2 min after being aged: $(op_state "$AP_OP")"
  case "$(op_state "$AP_OP" | cut -d' ' -f1)" in
    canceled) verdict I9.approval_window PASS "the worker canceled the aged awaiting_approval operation" ;;
    awaiting_approval) verdict I9.approval_window FAIL "an awaiting_approval operation 25 h old (window 4 h) is still awaiting_approval 2 min later: nothing expires it" ;;
    *) verdict I9.approval_window PARTIAL "state $(op_state "$AP_OP")" ;;
  esac
}

"${1:-inspect}"
