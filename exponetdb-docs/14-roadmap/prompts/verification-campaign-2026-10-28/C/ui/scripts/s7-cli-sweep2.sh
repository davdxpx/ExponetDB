#!/usr/bin/env bash
# S7 task 3, second pass: cases the first pass got wrong because of a fixture (an unknown dependency in the first bundle of a project,
# a production plan that was denied before the apply could ask for a confirmation, the sign-in state "server named, no credentials")
# and the approval / needs_attention / backup / node-plan cases. Appends to the same cases.tsv. Disposable lab only.
set -u
source /srv/work/s7/env.sh
L7=${L7:-/srv/work/logs-s7}; O=$L7/sweep; BIN=${EXSTACK_CLI_BIN}
cli()  { EXPONETDB_CONFIG_DIR="${CFG:-${EXSTACK_STATE}/cli}" node --liftoff-only "$BIN" "$@"; }
case_run() { local id=$1 want=$2 mode=$3; shift 3; local rc_t="-" rc_j="-"
  if [ "$mode" != J ]; then cli "$@" --no-color --no-input > "$O/$id.txt" 2>&1; rc_t=$?; fi
  if [ "$mode" != T ]; then cli "$@" --json --no-input > "$O/$id.json" 2>"$O/$id.json.err"; rc_j=$?; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$want" "$rc_t" "$rc_j" "${CFG_LABEL:-owner}" "$*" >> "$O/cases.tsv"; }
TN=lab/platform/s7sweep; TP=lab/platform/s7prd; CLUSTER=$(stack_id cluster_pg17); NODE=$(stack_id node)
# 1. unknown dependency, now with a bundle that really has one (two bundles; the second names an id that exists nowhere)
PD=$(new_project s7sweep2D); mkb "$PD" s7-sw2-a >/dev/null <<<"CREATE TABLE public.s7_sw2_a(id int primary key);"
BD=$(mkb "$PD" s7-sw2-b <<<"CREATE TABLE public.s7_sw2_b(id int primary key);"); sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn:\n  - 01ZZZZZZZZZZZZZZZZZZZZZZZX/}' "$PD"/migrations/*s7-sw2-b/migration.yaml
( cd "$PD" && case_run ref2-dependency-unknown 1 B migration plan --target "$TN" )
# 2. production plan that is allowed or needs an approval: an evidence-bearing one (genuine apply on the evidence target first)
PE=$(new_project s7sweep2E); BE=$(mkb "$PE" s7-sw2-ev <<<"CREATE TABLE public.s7_sw2_ev(id int primary key); GRANT SELECT ON public.s7_sw2_ev TO lab_owner;"); sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn: []/}' "$PE"/migrations/*/migration.yaml
mplan "$PE" lab/platform/s7evi "$BE" >/dev/null; mapply "$PLAN_ID" >/dev/null
( cd "$PE" && exdb_json migration plan --target "$TP" "$BE" > "$O/ev-plan.json" ); PPROD=$(jq -r '.data.id // empty' "$O/ev-plan.json"); echo "prod plan with evidence: $PPROD $(jq -r '.data.decision // .error.code' "$O/ev-plan.json")"
case_run ref2-prod-no-confirm 2 B plan apply "$PPROD"
# 3. sign-in states
mkdir -p "$O/emptycfg2"
CFG="$O/emptycfg2" CFG_LABEL=no-credentials case_run auth2-no-credentials 3 B migration status --target "$TN" --server http://localhost:58480
# 4. approvals and needs_attention operations that exist on the stack
AWAIT=$(ctl_sql "select operation_id from operations.operations where state='awaiting_approval' order by created_at limit 1"); ATTN=$(ctl_sql "select operation_id from operations.operations where state='needs_attention' and apply_outcome='applied' order by created_at limit 1")
echo "awaiting_approval op: ${AWAIT:-none}; needs_attention op (applied): ${ATTN:-none}"
[ -n "$AWAIT" ] && case_run ok2-approval-show 0 B approval show "$AWAIT"
[ -n "$AWAIT" ] && case_run ref2-approve-no-browser 4 B approval approve "$AWAIT"
[ -n "$AWAIT" ] && case_run ref2-cancel-awaiting 0 T operation cancel "$AWAIT"
[ -n "$ATTN" ] && case_run ok2-op-attention 0 B operation show "$ATTN"
[ -n "$ATTN" ] && case_run ref2-retry-verify-attention 0 J operation retry-verification "$ATTN"
# 5. backup and node plans
REPO=$(exdb_json backup repositories "$CLUSTER" | jq -r '.data.items[0].repositoryId // .data.items[0].id // .data[0].repositoryId // empty')
echo "repository: ${REPO:-none}"
[ -n "$REPO" ] && case_run ref2-backup-run 4 B backup run "$CLUSTER" --repository "$REPO" --kind full --no-wait
[ -n "$REPO" ] && case_run ref2-backup-verify 1 B backup verify "$CLUSTER" --repository "$REPO" --backup 20200101-000000F
case_run ok2-node-revoke-plan 0 B node revoke "$NODE" --no-wait
case_run ok2-drill-plan 1 B drill plan "$CLUSTER" --kind latest
# 6. a finding that exists
FND=$(exdb_json finding list --limit 1 | jq -r '.data.items[0].id // .data[0].id // empty'); FT=$(exdb_json finding list --limit 1 | jq -r '.data.items[0].targetId // .data[0].targetId // empty')
[ -n "$FND" ] && case_run ok2-finding-show 0 B finding show "$FND" --target "$FT"
echo "second pass done: $(wc -l < "$O/cases.tsv") cases"
