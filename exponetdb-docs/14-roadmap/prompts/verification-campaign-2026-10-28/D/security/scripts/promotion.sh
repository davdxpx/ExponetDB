#!/usr/bin/env bash
# S4 task 6 (I12, the benign part): production accepts only a checksum applied AND verified on the evidence environment.
# Case 1: a bundle never applied on the evidence target. Case 2: applied on another nonprod environment (dev16), not the evidence one.
# Case 3: the same id re-uploaded with other bytes after it was applied on the evidence target. Plans only; nothing is applied to production.
source /srv/work/s4/env.sh
cd $S4; refresh_creds
PRD=$(stack_id target_s4prd)
show() { jq -c '{decision,state,evidence:[.change.analysis.evidence[]?|{status,lineage}],failed:[.policyRules[]?|select(.result!="pass")|{id,severity}]}' "$1" | cut -c1-330; }
plan_prod() { curl -s -X POST -H "Authorization: Bearer $(cat creds/owner.token)" -H 'content-type: application/json' -d "{\"migrationIds\":[\"$1\"]}" http://127.0.0.1:58480/api/v1/targets/$PRD/migrations/plans > $L4/api/promo-case$2.json; show $L4/api/promo-case$2.json; }
P=$(new_project s4promo8)
mkb $P s4-promo-i >/dev/null <<<"CREATE TABLE public.s4_i(id int primary key); GRANT SELECT ON public.s4_i TO lab_owner;"
IDI=$(ls $P/migrations | grep s4-promo-i | cut -d_ -f1)
echo "case 1: never applied anywhere (bundle stored by a plan on dev16 that is NOT applied)"
mplan $P lab/platform/dev18 >/dev/null     # stores the bundle; the plan is not applied
plan_prod $IDI 1
echo "case 2: applied and verified on dev16 only (a nonprod environment that is not the evidence source)"
mplan $P lab/platform/dev16 >/dev/null; mapply $PLAN_ID | cut -c1-110
plan_prod $IDI 2
echo "case 3: applied and verified on the evidence target s4evi, then the same id with other bytes"
mplan $P lab/platform/s4evi >/dev/null; mapply $PLAN_ID | cut -c1-110
d=$(ls -d $P/migrations/${IDI}_*); cp $d/up.sql $d/up.sql.orig; echo "CREATE TABLE public.s4_i(id int primary key, extra text); GRANT SELECT ON public.s4_i TO lab_owner;" > $d/up.sql
(cd $P && exdb migration plan --target lab/platform/s4prd 2>&1 | head -3 | cut -c1-200)
echo "same id, other bytes, planned for the evidence target again:"; mplan $P lab/platform/s4evi | cut -c1-140
