source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
ctl_sql "select table_schema||'.'||table_name from information_schema.tables where table_name like '%finding%'" | head
runuser -u postgres -- env PGOPTIONS='-c role=lab_owner' psql -X -q -p 55537 -d lab_rhrep -v ON_ERROR_STOP=1 <<'SQL' 2>&1 | tail -2
DO $$ BEGIN FOR i IN 1..3000 LOOP EXECUTE format('create table public.t10k_%s (id integer primary key)', lpad(i::text, 4, '0')); END LOOP; END $$;
SQL
echo "3000 tables created"
