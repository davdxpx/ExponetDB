source /srv/work/s5/rehearsal/rh-lib.sh
cd $L
echo "== import report (rhstg) states"; jq -r '.data.items | group_by(.state) | map("\(.[0].state)=\(length)") | join(" ")' report-rhstg.json
echo "== decisions needed (items that were ambiguous) and how they were resolved"; ctl_sql "select i.item_id, i.state, coalesce(i.decision,'-'), left(i.name,60) from migrations.import_items i join migrations.import_reports r using (report_id) where r.target_id='$(target_id lab/platform/rhstg)' and i.decision is not null order by i.item_id::int" 2>&1 | head -30
echo "== replay diff (I10)"; jq -r '.data.groups[] | "\(.objectClass): +\(.added|length) -\(.removed|length) ~\(.changed|length)"' replay-diff.json 2>/dev/null
echo "== analysis memory (MB serve/worker/gateway) first/peak"; head -1 mem-a3.log; for i in 2 3 4; do awk -v c=$i '{split($c,a,"="); if (a[2]>m) m=a[2]} END{printf "%s ", m}' mem-a3.log; done; echo
echo "== inventory of the staging-like database"; runuser -u postgres -- psql -X -At -F' ' -p 55537 -d lab_rhstg -f $RH/inventory.sql | tr '\n' ';'; echo
echo "== table sizes"; runuser -u postgres -- psql -X -At -p 55537 -d lab_rhstg -c "select schemaname||'.'||relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 6" | tr '\n' ';'; echo
echo "== ledger rows"; runuser -u postgres -- psql -X -At -p 55537 -d lab_rhstg -c "select origin, count(*) from exponetdb.schema_migrations group by 1"
