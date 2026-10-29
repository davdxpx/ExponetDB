set -uo pipefail
source /srv/work/s5kit/stack-env.sh
cd /srv/work/s5/rehearsal
L=/srv/work/logs-s5
# 1) project scope
PID=$(stack_id project)
BODY='{"managedScope":{"includeSchemas":["public","auth","storage","app_private"],"excludeSchemas":[]},"trustedExtensions":["pgcrypto","uuid-ossp","pg_trgm","pg_stat_statements"]}'
human call POST /api/v1/projects/$PID/change-plans "$BODY" | tee $L/project-scope-plan.json | cut -c1-300
PLAN=$(jq -r '.body.id' $L/project-scope-plan.json)
human apply "$PLAN" --approve | cut -c1-300
sleep 3
human call GET /api/v1/projects/$PID | jq -c '.body | {managedScope, trustedExtensions, executionRoles}'
# 2) history on staging-like and production-like databases
for db in lab_rhstg lab_rhprod; do ./apply_legacy.sh $db 55417 2>&1 | grep -v NOTICE | tail -3; done
for db in lab_rhstg lab_rhprod; do
  psql_target pg17 -d $db -X -q -c "grant usage on schema supabase_migrations to exponetdb_observer; grant select on supabase_migrations.schema_migrations to exponetdb_observer;"
done
