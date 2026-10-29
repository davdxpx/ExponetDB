#!/usr/bin/env bash
# The safe form of the index bundle: CREATE INDEX CONCURRENTLY alone in a non-transactional bundle, staging first, then production.
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
VERIFY_SQL="SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public' AND indexname='notifications_user_org_cc_idx') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE NOT i.indisvalid) AS ok;" \
mkb "$PROJ" index-notifications-concurrently --nontransactional --depends-on baseline:rehearsal-2024 > "$L/f1.id" <<'SQL'
CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_user_org_cc_idx ON public.notifications (user_id, org_id);
SQL
F1=$(cat "$L/f1.id")
echo "lint at the prod tier:"; exdb migration lint 2>&1 | grep -E "$F1|BLOCKED|OK " | head -5 | cut -c1-200
TAIL=6 tm f1-plan-staging exdb migration plan "$F1" --target lab/platform/rhstg
PL=$(grep -o "pln_[A-Z0-9]*" "$L/f1-plan-staging.log" | head -1); TAIL=7 tm f1-apply-staging exdb plan apply "$PL" --wait
TAIL=22 tm f1-plan-prod exdb migration plan "$F1" --target lab/platform/rhprod
PL=$(grep -o "pln_[A-Z0-9]*" "$L/f1-plan-prod.log" | head -1)
/srv/work/s5/rehearsal/prod_apply.sh "$PL" f1 2>&1 | tail -3 | cut -c1-200
psql_target pg18 -c 'select 1' >/dev/null 2>&1
runuser -u postgres -- psql -X -Atq -p 55537 -d lab_rhprod -c "select indexrelid::regclass||' valid='||indisvalid from pg_index where indexrelid::regclass::text like 'notifications_user_org_cc%'"
