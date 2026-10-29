#!/usr/bin/env bash
# S7 task 3: CLI sweep. Each case runs once in text mode and once in --json mode (or only one of them for a state-changing call),
# and records: exit code, whether the text names a next step, the JSON error envelope (code, message, remediation, ids in details).
# Output: $L7/sweep/cases.tsv and the raw outputs next to it. Disposable lab only (stack of D/infra).
# usage on the server:  bash s7-cli-sweep.sh        (about 6 minutes)
set -u
source /srv/work/s7/env.sh
L7=${L7:-/srv/work/logs-s7}; O=$L7/sweep; rm -rf "$O"; mkdir -p "$O"; : > "$O/cases.tsv"
BIN=${EXSTACK_CLI_BIN}
cli()  { EXPONETDB_CONFIG_DIR="${CFG:-${EXSTACK_STATE}/cli}" node --liftoff-only "$BIN" "$@"; }
# case ID EXPECTED_RC MODE(B|T|J) args...   : EXPECTED_RC is what docs/exit.ts say the exit code of this situation is
case_run() {
  local id=$1 want=$2 mode=$3; shift 3
  local rc_t="-" rc_j="-"
  if [ "$mode" != J ]; then cli "$@" --no-color --no-input > "$O/$id.txt" 2>&1; rc_t=$?; fi
  if [ "$mode" != T ]; then cli "$@" --json --no-input > "$O/$id.json" 2>"$O/$id.json.err"; rc_j=$?; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$want" "$rc_t" "$rc_j" "${CFG_LABEL:-owner}" "$*" >> "$O/cases.tsv"
}
latest_plan()  { exdb_json plan list --limit 1 2>/dev/null | jq -r '.data.items[0].id // .data[0].id // empty'; }
T=lab/platform/dev16; TN=lab/platform/s7sweep; TP=lab/platform/s7prd
CLUSTER=$(stack_id cluster_pg17); NODE=$(stack_id node)
add_target s7sweep pg17 >/dev/null
P=$(new_project s7sweep); cd "$P" || exit 1
indep() { sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn: []/}' "$P"/migrations/*"$1"/migration.yaml; }
b() { local id; id=$(mkb "$P" "$1" <<<"CREATE TABLE public.$2(id int primary key); GRANT SELECT ON public.$2 TO lab_owner;"); indep "$1"; echo "$id"; }
B1=$(b s7-sw-ok1 s7_sw_ok1); B2=$(b s7-sw-ok2 s7_sw_ok2); B3=$(b s7-sw-ok3 s7_sw_ok3); B4=$(b s7-sw-ok4 s7_sw_ok4); B5=$(b s7-sw-ok5 s7_sw_ok5)

# ---------- typical successful calls ----------
case_run ok-status        0 B migration status --target "$TN"
case_run ok-lint          0 B migration lint
case_run ok-checksum      0 B migration checksum
case_run ok-graph         0 B migration graph
case_run ok-plan          0 B migration plan --target "$TN" "$B1"
case_run ok-apply-text    0 T migration apply --target "$TN" "$B2"
case_run ok-apply-json    0 J migration apply --target "$TN" "$B3"
case_run ok-plan-list     0 B plan list --limit 3
PL=$(latest_plan); case_run ok-plan-show 0 B plan show "$PL"
case_run ok-op-list       0 B operation list --limit 3
OP=$(exdb_json operation list --limit 1 | jq -r '.data.items[0].id // .data[0].id // empty'); case_run ok-op-show 0 B operation show "$OP"
case_run ok-approval-list 0 B approval list
case_run ok-drift-check   0 B drift check "$TN"
case_run ok-finding-list  0 B finding list
case_run ok-finding-sum   0 B finding summary
case_run ok-health        0 B health "$TN"
case_run ok-backup-over   0 B backup overview
case_run ok-backup-list   0 B backup list "$CLUSTER"
case_run ok-backup-repos  0 B backup repositories "$CLUSTER"
case_run ok-backup-runs   0 B backup runs "$CLUSTER"
case_run ok-backup-policy 0 B backup policy show "$CLUSTER"
case_run ok-restore-list  0 B restore list "$CLUSTER"
case_run ok-drill-list    0 B drill list "$CLUSTER"
case_run ok-node-list     0 B node list
case_run ok-node-show     0 B node show "$NODE"
case_run ok-node-status   0 B node status "$NODE"
case_run ok-node-caps     0 B node capabilities "$NODE"
case_run ok-node-inspect  0 B node inspect "$NODE" --capability cpu.stats@1 --timeout-wait 60s

# ---------- missing or invalid arguments ----------
case_run arg-plan-no-target   2 B migration plan
case_run arg-plan-bad-target  1 B migration plan --target lab/platform/nope "$B4"
case_run arg-plan-bad-id      2 B migration plan --target "$TN" not-an-id
case_run arg-apply-no-plan    2 B plan apply
case_run arg-apply-bad-plan   1 B plan apply pln_00000000000000000000000000 --yes
case_run arg-show-no-id       2 B plan show
case_run arg-show-bogus       1 B plan show pln_00000000000000000000000000
case_run arg-op-bogus         1 B operation show op_00000000000000000000000000
case_run arg-approval-bogus   1 B approval show op_00000000000000000000000000
case_run arg-node-no-id       2 B node show
case_run arg-node-bogus       1 B node show nod_00000000000000000000000000
case_run arg-backup-no-cluster 2 B backup list
case_run arg-backup-bogus     1 B backup list cls_00000000000000000000000000
case_run arg-finding-bogus    1 B finding show fnd_00000000000000000000000000 --target "$TN"
case_run arg-drift-bad-target 1 B drift check lab/platform/nope
case_run arg-bad-output       2 T migration status --target "$TN" --output xml
case_run arg-unknown-cmd      2 T migration frobnicate
case_run arg-unknown-flag     2 B migration status --target "$TN" --frobnicate

# ---------- refusals with a reason ----------
# checksum mismatch: the same id with other bytes after it was applied
PB=$(new_project s7sweepB); DB="$PB/migrations/$(ls "$P/migrations" | grep "^${B2}_")"; mkdir -p "$DB"; cp "$P/migrations/$(ls "$P/migrations" | grep "^${B2}_")/migration.yaml" "$DB"/; printf 'CREATE TABLE public.s7_sw_other(id int primary key);\n' > "$DB/up.sql"; cp "$P/migrations/$(ls "$P/migrations" | grep "^${B2}_")/verify.sql" "$DB"/
( cd "$PB" && case_run ref-checksum 1 B migration plan --target "$TN" "$B2" )
# unknown dependency
PD=$(new_project s7sweepD); BD=$(mkb "$PD" s7-sw-dep <<<"CREATE TABLE public.s7_sw_dep(id int primary key);"); sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn:\n  - 01ZZZZZZZZZZZZZZZZZZZZZZZX/}' "$PD"/migrations/*s7-sw-dep/migration.yaml
( cd "$PD" && case_run ref-dependency 1 B migration plan --target "$TN" )
# lint blocks (strict): a table without primary key plus a destructive drop
PL2=$(new_project s7sweepL); mkb "$PL2" s7-sw-lint >/dev/null <<<"DROP SCHEMA public CASCADE;"
( cd "$PL2" && case_run ref-lint-block 1 B migration lint )
( cd "$PL2" && case_run ref-lint-plan 1 B migration plan --target "$TN" )
# denied by policy: production without evidence
case_run ref-policy-prod 4 B migration plan --target "$TP" "$B4"
# plan already used / stale / stale by ledger
mplan "$P" "$TN" "$B4" >/dev/null; PUSED=$PLAN_ID; mapply "$PUSED" >/dev/null
case_run ref-plan-used 1 B plan apply "$PUSED" --yes
mplan "$P" "$TN" "$B5" >/dev/null; PSTALE=$PLAN_ID
echo "CREATE TABLE public.s7_sw_move(id int primary key);" > /dev/null
PM=$(new_project s7sweepM); mkb "$PM" s7-sw-move >/dev/null <<<"CREATE TABLE public.s7_sw_move(id int primary key); GRANT SELECT ON public.s7_sw_move TO lab_owner;"; sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn: []/}' "$PM"/migrations/*/migration.yaml
mplan "$PM" "$TN" >/dev/null; mapply "$PLAN_ID" >/dev/null     # moves the target on: PSTALE is now stale
case_run ref-plan-stale 1 B plan apply "$PSTALE" --yes
case_run ref-prod-confirm 2 B plan apply "$(cd "$P" && exdb_json migration plan --target "$TP" "$B4" | jq -r '.data.id // empty')"
# operation exits
OPOK=$(ctl_sql "select operation_id from operations.operations where state='succeeded' and kind='migration.apply' order by created_at desc limit 1")
case_run ref-retry-verify 1 B operation retry-verification "$OPOK"
case_run ref-cancel-final 1 B operation cancel "$OPOK"
case_run ref-watch-final  0 B operation watch "$OPOK"
case_run ref-rollback-nodown 1 B migration rollback "$B2" --target "$TN"
case_run ref-resume-notstopped 1 B migration resume "$B2" --target "$TN"
case_run ref-reconcile-ok 0 B migration ledger reconcile --target "$TN" --note "sweep: nothing to adopt"

# ---------- unauthorized ----------
CFG=/srv/work/s4/cli/viewer CFG_LABEL=viewer case_run auth-viewer-apply 3 B migration apply --target "$TN" "$B1"
CFG=/srv/work/s4/cli/viewer CFG_LABEL=viewer case_run auth-viewer-drift 3 B drift check "$TN"
CFG=/srv/work/s4/cli/viewer CFG_LABEL=viewer case_run auth-viewer-backup-run 3 B backup run "$CLUSTER" --repository bkr_00000000000000000000000000 --kind full
CFG=/srv/work/s4/cli/viewer CFG_LABEL=viewer case_run auth-viewer-node-revoke 3 B node revoke "$NODE"
CFG=/srv/work/s4/cli/viewer CFG_LABEL=viewer case_run auth-viewer-prod-plan 3 B migration plan --target "$TP" "$B4"
CFG=/srv/work/s4/cli/viewer CFG_LABEL=viewer case_run auth-viewer-approve 3 B approval list
CFG=/srv/work/s4/cli/viewer CFG_LABEL=viewer case_run auth-viewer-audit 3 B audit list --limit 2
mkdir -p "$O/emptycfg"; CFG="$O/emptycfg" CFG_LABEL=signed-out case_run auth-signed-out 3 B migration status --target "$TN"
CFG=/srv/work/s4/cli/developer-nonprod CFG_LABEL=developer-nonprod case_run auth-dev-revoked 3 B migration status --target "$TN"

# ---------- unreachable ----------
CFG_LABEL=owner case_run net-server-down 5 B migration status --target "$TN" --server http://127.0.0.1:1
net_block 55417 reject >/dev/null 2>&1
case_run net-target-down 5 B migration status --target "$TN"
case_run net-target-drift 5 B drift check "$TN"
case_run net-target-health 0 B health "$TN"
net_unblock >/dev/null 2>&1
systemctl stop exponetdb-node 2>/dev/null; sleep 2
case_run net-node-stopped 5 B node inspect "$NODE" --capability cpu.stats@1 --timeout-wait 20s
case_run net-backup-refresh-nodedown 1 B backup refresh "$CLUSTER"
case_run net-node-status-down 0 B node status "$NODE"
systemctl start exponetdb-node 2>/dev/null; systemctl start exponetdb-node-helper 2>/dev/null
sleep 20; case_run net-node-restored 0 B node status "$NODE"
echo "sweep done: $(wc -l < "$O/cases.tsv") cases"
