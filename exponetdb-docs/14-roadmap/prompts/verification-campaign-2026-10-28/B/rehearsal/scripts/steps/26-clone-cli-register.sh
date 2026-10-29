source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
CL=$(stack_id cluster_pg17); DBID=$(human call GET /api/v1/clusters/$CL/databases | jq -r '.body.items[] | select(.name=="lab_rhclone") | .id')
echo "--- CLI register of the clone"
exdb target register --project $(stack_id project) --environment $(stack_id env_rhclone) --database $DBID 2>&1 | tail -6 | cut -c1-300
