#!/usr/bin/env bash
# S7 task 2b: an evidence run that was APPLIED but NOT VERIFIED (verify.sql returns false / errors), then the same bundle planned for production.
# Also: a verified-then-reverted bundle (rollback) and an applied bundle whose later re-verification fails. Disposable lab only.
# usage on the server: ./s7-promo-unverified.sh <evidence slug> <prod slug>
set -u
source /srv/work/s7/env.sh
EVI=${1:-s7evi}; PRD=${2:-s7prd}; EVI3=${3:-$EVI}; PRD3=${4:-$PRD};  # U3 needs its own pair when U2 left the first evidence target in needs_attention (it holds the schema lock)
L7=${L7:-/srv/work/logs-s7}
P=$(new_project s7unver); cd "$P" || exit 1
row() { jq -c --arg id "$1" '{decision:.data.decision,state:.data.state,err:.error.code,evidence:[.data.change.analysis.evidence[]?|select(.migrationId==$id)|{status,lineage}],rules:[.data.policyRules[]?|select(.result!="pass")|{id,severity,result}]}' "$2"; }
indep() { sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn: []/}' "$P"/migrations/*"$1"/migration.yaml; }
prodplan() { exdb_json migration plan --target "lab/platform/${PRD}" "$1" > "$L7/unver-$2.json"; row "$1" "$L7/unver-$2.json"; }

if [ "${ONLY3:-0}" != 1 ]; then
echo "== U1: verify.sql returns false after a successful apply"
ID1=$(VERIFY_SQL='-- check: this must fail
SELECT false AS ok;' mkb "$P" s7-unver-false <<<"CREATE TABLE public.s7_unver_false(id int primary key); GRANT SELECT ON public.s7_unver_false TO lab_owner;"); indep s7-unver-false
mplan "$P" "lab/platform/${EVI}" "$ID1"; mapply "$PLAN_ID" | cut -c1-220
echo "   evidence target ledger + verification rows:"
ledger pg17 lab_${EVI} | grep "$ID1" | cut -c1-120
PGDATABASE=lab_${EVI} psql_target pg17 -Atc "select migration_id, status from exponetdb.migration_verifications where migration_id='$ID1'"
echo "   production plan:"; prodplan "$ID1" u1

echo "== U2: verify.sql errors (division by zero) after a successful apply"
ID2=$(VERIFY_SQL='-- check: this errors
SELECT 1/0 AS ok;' mkb "$P" s7-unver-error <<<"CREATE TABLE public.s7_unver_error(id int primary key); GRANT SELECT ON public.s7_unver_error TO lab_owner;"); indep s7-unver-error
mplan "$P" "lab/platform/${EVI}" "$ID2"; mapply "$PLAN_ID" | cut -c1-220
PGDATABASE=lab_${EVI} psql_target pg17 -Atc "select migration_id, status from exponetdb.migration_verifications where migration_id='$ID2'"
prodplan "$ID2" u2

fi
echo "== U3: verified on the evidence target, then rolled back there (down.sql), then planned for production"
ID3=$(DOWN_SQL='DROP TABLE public.s7_unver_rb;' mkb "$P" s7-unver-rb <<<"CREATE TABLE public.s7_unver_rb(id int primary key); GRANT SELECT ON public.s7_unver_rb TO lab_owner;"); indep s7-unver-rb
mplan "$P" "lab/platform/${EVI3}" "$ID3"; mapply "$PLAN_ID" | cut -c1-220
echo "   before the rollback:"; PRD=$PRD3 prodplan "$ID3" u3a
RB=$(exdb_json migration rollback --target "lab/platform/${EVI3}" "$ID3" 2>&1); echo "$RB" | jq -c '{err:.error.code,msg:.error.message,plan:.data.id,state:.data.state,decision:.data.decision}' | cut -c1-300
RBPLAN=$(echo "$RB" | jq -r '.data.id // empty')
if [ -n "$RBPLAN" ]; then mapply "$RBPLAN" | cut -c1-220; echo "   after the rollback:"; PRD=$PRD3 prodplan "$ID3" u3b; fi
echo "== U4: the evidence target is restored (an older ledger): see PITR in C/backup-restore; not repeated here"
