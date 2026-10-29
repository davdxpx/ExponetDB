#!/usr/bin/env bash
# S7 task 2a: alias / label swap through the registry (registry.environment.update, action class "high").
# A1 swap the display names of the evidence and the production environment; A2 re-point the production environment's evidence source to another
# nonprod environment; A3 remove the evidence source; A4 flip the production environment to nonprod (refused: tier_in_use).
# Disposable lab only. usage: ./s7-promo-alias.sh <evidence slug> <prod slug> <other nonprod slug>
set -u
source /srv/work/s7/env.sh
EVI=${1:-s7evic}; PRD=${2:-s7prdc}; OTH=${3:-dev16}; L7=${L7:-/srv/work/logs-s7}
envid() { exdb environment list lab 2>&1 | awk -v s="$1" '$2==s {print $1}'; }
EV=$(envid $EVI); PR=$(envid $PRD); OT=$(envid $OTH)
# apply from the CLI that created the plan (a plan is bound to its actor and client); a high class asks for a fresh passkey confirmation,
# which the scripted owner (human.ts) gives when the CLI prints the step-up id and code
happly() { local plan=$1 out; out=$L7/happly-$RANDOM.out; : >"$out"
  ( timeout 150 env EXPONETDB_CONFIG_DIR="${EXSTACK_STATE}/cli" node --liftoff-only "${EXSTACK_CLI_BIN}" plan apply "$plan" --yes --wait >"$out" 2>&1; echo "cli-exit=$?" >>"$out" ) &
  local pid=$! stu="" code="" i
  for i in $(seq 1 40); do stu=$(grep -Eo 'stu_[0-9A-Z]{26}' "$out" | head -1); code=$(grep -Eo 'Code: [A-Z0-9-]+' "$out" | head -1 | cut -d' ' -f2); [ -n "$stu" ] && [ -n "$code" ] && break; grep -q cli-exit "$out" && break; sleep 1; done
  if [ -n "$stu" ]; then echo "   step-up requested ($stu): $(human call POST "/api/v1/step-ups/$stu/confirm" "{\"userCode\":\"$code\"}" 2>&1 | head -1 | cut -c1-100)"; fi
  wait $pid; echo "   cli: $(grep -E 'cli-exit|succeeded|Error|error|applied' "$out" | tr '\n' ' ' | cut -c1-260)"; }
brief() { jq -c '{err:.error.code,reason:.error.details.reason,plan:.data.id,state:.data.state,decision:.data.decision,class:.data.class,approvals:(.data.approvals|length?),needs:[.data.policyRules[]?|select(.result!="pass")|{id,severity,result}]}' "$1" | cut -c1-500; }
P=$(new_project s7alias); cd "$P" || exit 1
T=s7_alias_$RANDOM$RANDOM
ID=$(mkb "$P" s7-alias-b <<<"CREATE TABLE public.$T(id int primary key); GRANT SELECT ON public.$T TO lab_owner;")
sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn: []/}' "$P"/migrations/*s7-alias-b/migration.yaml
ev() { exdb_json migration plan --target "lab/platform/${PRD}" "$ID" > "$L7/alias-plan-$1.json"; jq -c --arg id "$ID" '{decision:.data.decision,err:.error.code,evidence:[.data.change.analysis.evidence[]?|select(.migrationId==$id)|{status,evidenceTargetId}]}' "$L7/alias-plan-$1.json"; }
echo "evidence env=$EV production env=$PR other nonprod env=$OT"
echo "== A0 baseline: the bundle is applied nowhere; production plan"; ev a0
echo "== A1 swap the display names of the two environments"
exdb_json environment update lab "$EV" --name "production" > "$L7/alias-a1a.json"; brief "$L7/alias-a1a.json"; happly "$(jq -r '.data.id' "$L7/alias-a1a.json")"
exdb_json environment update lab "$PR" --name "staging" > "$L7/alias-a1b.json"; brief "$L7/alias-a1b.json"; happly "$(jq -r '.data.id' "$L7/alias-a1b.json")"
exdb environment list lab 2>&1 | grep -E "$EV|$PR" | cut -c1-120
echo "   production plan after the swap of names (evidence is bound by id, not by name):"; ev a1
echo "== A2 re-point production's evidence source to ANOTHER nonprod environment ($OTH); bundle applied+verified only there"
mplan "$P" "lab/platform/${OTH}" "$ID" >/dev/null; mapply "$PLAN_ID" | cut -c1-160
echo "   before the re-point:"; ev a2pre
exdb_json environment update lab "$PR" --evidence-from "$OTH" > "$L7/alias-a2.json"; brief "$L7/alias-a2.json"
A2PLAN=$(jq -r '.data.id // empty' "$L7/alias-a2.json")
echo "   apply the registry plan (owner: fresh passkey confirmation):"; happly "$A2PLAN"
exdb environment list lab 2>&1 | grep -E "$PR" | cut -c1-120
echo "   after the re-point:"; ev a2post
echo "== A3 remove the evidence source"
exdb_json environment update lab "$PR" --no-evidence-from > "$L7/alias-a3.json"; brief "$L7/alias-a3.json"
A3PLAN=$(jq -r '.data.id // empty' "$L7/alias-a3.json"); happly "$A3PLAN"
ev a3
echo "== A4 flip the production environment to nonprod"
exdb_json environment update lab "$PR" --tier nonprod > "$L7/alias-a4.json"; brief "$L7/alias-a4.json"
echo "== restore: evidence source back to the original, names back"
exdb_json environment update lab "$PR" --evidence-from "$EVI" --name "$PRD" > "$L7/alias-r1.json"; brief "$L7/alias-r1.json"; happly "$(jq -r '.data.id' "$L7/alias-r1.json")"
exdb_json environment update lab "$EV" --name "$EVI" > "$L7/alias-r2.json"; brief "$L7/alias-r2.json"; happly "$(jq -r '.data.id' "$L7/alias-r2.json")"
exdb environment list lab 2>&1 | grep -E "$EV|$PR" | cut -c1-120
