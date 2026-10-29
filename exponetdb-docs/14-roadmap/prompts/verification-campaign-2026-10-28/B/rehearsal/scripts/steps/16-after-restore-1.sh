source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
awk '{ts=$2; if (ts < "2026-10-29T21:08:17.001") n++} END{print "markers committed before T_target (client log): " n}' $L/marker.log
runuser -u postgres -- psql -X -Atq -p 55417 -d lab_rhstg -c "select 'B6 table: '||coalesce(to_regclass('public.rh_marker')::text,'-')||'  B7 table: '||coalesce(to_regclass('public.region_settings')::text,'-')||'  ledger head: '||(select migration_id||' '||name from exponetdb.schema_migrations order by applied_seq desc limit 1)"
echo "=== the Control Plane after the restore, $(date -u +%T)"
TAIL=25 tm target-show-after-restore exdb target show lab/platform/rhstg
TAIL=25 tm migration-status-after-restore exdb migration status --target lab/platform/rhstg
