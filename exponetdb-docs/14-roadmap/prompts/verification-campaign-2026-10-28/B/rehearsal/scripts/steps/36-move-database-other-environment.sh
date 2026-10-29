source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
PR=$(stack_id product); CL=$(stack_id cluster_pg18)
PL=$(human call POST /api/v1/products/$PR/environments '{"slug":"rhmvn","displayName":"moved","tier":"nonprod"}' | jq -r '.body.id'); human apply $PL | cut -c1-100; sleep 2
ENV=$(human call GET /api/v1/products/$PR/environments | jq -r '.body.items[] | select(.slug=="rhmvn") | .id')
DBID=$(human call GET /api/v1/clusters/$CL/databases | jq -r '.body.items[] | select(.name=="lab_rhmv2") | .id')
echo "env=$ENV db=$DBID"
exdb target register --project $(stack_id project) --environment $ENV --database $DBID 2>&1 | tail -5 | cut -c1-300
