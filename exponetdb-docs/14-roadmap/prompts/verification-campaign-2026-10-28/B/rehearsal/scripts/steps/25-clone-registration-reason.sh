source /srv/work/s5/rehearsal/rh-lib.sh
CL=$(stack_id cluster_pg17); PRJ=$(stack_id project)
for slug in rhclone rhclone2; do
  ENV=$(stack_id env_$slug)
  DBID=$(human call GET /api/v1/clusters/$CL/databases | jq -r --arg n lab_$slug '.body.items[] | select(.name==$n) | .id')
  echo "--- $slug env=$ENV db=$DBID"
  human call POST /api/v1/targets "{\"projectId\":\"$PRJ\",\"environmentId\":\"$ENV\",\"databaseId\":\"$DBID\"}" | jq -c '.body | {code, message, details, reason, errors}' | cut -c1-900
done
