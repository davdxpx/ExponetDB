source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ; P=55418
SU() { runuser -u postgres -- psql -X -q -p $P -d postgres -v ON_ERROR_STOP=1 "$@"; }
kick() { SU -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$1' and pid<>pg_backend_pid()" >/dev/null; }
kick lab_rh18; kick lab_rh18_orig
SU -c "alter database lab_rh18 rename to lab_rh18c" && SU -c "alter database lab_rh18_orig rename to lab_rh18" && SU -c "drop database lab_rh18c"
sleep 4; exdb migration status --target lab/platform/rh18 2>&1 | sed -n 3,6p
echo "=== way forward for a clone that should be a NEW target: remove the copied exponetdb schema, register again"
runuser -u postgres -- psql -X -q -p 55417 -d lab_rhclone -c "drop schema exponetdb cascade" 2>&1 | tail -1
CL=$(stack_id cluster_pg17); DBID=$(human call GET /api/v1/clusters/$CL/databases | jq -r '.body.items[] | select(.name=="lab_rhclone") | .id')
exdb target register --project $(stack_id project) --environment $(stack_id env_rhclone) --database $DBID 2>&1 | tail -4 | cut -c1-300
echo "--- after bootstrap-sql (the operator's next step for a database without a marker)"
human call GET "/api/v1/clusters/$CL/bootstrap-sql?database=lab_rhclone&project=$(stack_id project)" | jq -r '.body.script' > $L/bootstrap-clone.sql
runuser -u postgres -- psql -X -q -p 55417 -d postgres -v ON_ERROR_STOP=1 -f $L/bootstrap-clone.sql 2>&1 | tail -2
PLAN=$(exdb_json target register --project $(stack_id project) --environment $(stack_id env_rhclone) --database $DBID | jq -r '.data.id')
echo "plan=$PLAN"; exdb plan apply $PLAN --wait 2>&1 | tail -5 | cut -c1-200
