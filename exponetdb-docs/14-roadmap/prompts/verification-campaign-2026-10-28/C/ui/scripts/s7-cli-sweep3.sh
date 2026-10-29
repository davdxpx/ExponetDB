#!/usr/bin/env bash
# S7 task 3, third pass: backup cases with a real repository id, the production confirmation prompt, a node plan. Appends to cases.tsv. Disposable lab only.
set -u
source /srv/work/s7/env.sh
L7=${L7:-/srv/work/logs-s7}; O=$L7/sweep; BIN=${EXSTACK_CLI_BIN}
cli()  { EXPONETDB_CONFIG_DIR="${CFG:-${EXSTACK_STATE}/cli}" node --liftoff-only "$BIN" "$@"; }
case_run() { local id=$1 want=$2 mode=$3; shift 3; local rc_t="-" rc_j="-"
  if [ "$mode" != J ]; then cli "$@" --no-color --no-input > "$O/$id.txt" 2>&1; rc_t=$?; fi
  if [ "$mode" != T ]; then cli "$@" --json --no-input > "$O/$id.json" 2>"$O/$id.json.err"; rc_j=$?; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$want" "$rc_t" "$rc_j" "${CFG_LABEL:-owner}" "$*" >> "$O/cases.tsv"; }
CLUSTER=$(stack_id cluster_pg17); NODE=$(stack_id node)
REPO=$(exdb_json backup repositories "$CLUSTER" | jq -r '.data.repositories[0].id // empty'); echo "repository ${REPO:-none}"
[ -n "$REPO" ] && case_run ref3-backup-run 4 B backup run "$CLUSTER" --repository "$REPO" --kind full --no-wait
[ -n "$REPO" ] && case_run ref3-backup-verify 1 B backup verify "$CLUSTER" --repository "$REPO" --backup 20200101-000000F --no-wait
case_run ref3-backup-refresh 0 B backup refresh "$CLUSTER" --no-wait
# a production plan that is not denied, then apply without --yes in no-input mode
PE=$(new_project s7sweep3E); BE=$(mkb "$PE" s7-sw3-ev <<<"CREATE TABLE public.s7_sw3_ev(id int primary key); GRANT SELECT ON public.s7_sw3_ev TO lab_owner;"); sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn: []/}' "$PE"/migrations/*/migration.yaml
add_target s7sw3evi pg17 >/dev/null; add_target s7sw3prd pg17 prod >/dev/null 2>&1
# the production environment of the new pair has the default evidence source; use the pair of the first pass instead: s7evic -> s7prdc
mplan "$PE" lab/platform/s7evic "$BE" >/dev/null; mapply "$PLAN_ID" >/dev/null
( cd "$PE" && exdb_json migration plan --target lab/platform/s7prdc "$BE" > "$O/ev3-plan.json" ); PPROD=$(jq -r '.data.id // empty' "$O/ev3-plan.json"); echo "prod plan: ${PPROD:-none} decision=$(jq -r '.data.decision // .error.code' "$O/ev3-plan.json")"
[ -n "$PPROD" ] && case_run ref3-prod-no-confirm 2 B plan apply "$PPROD"
echo "third pass done: $(wc -l < "$O/cases.tsv") cases"
