#!/usr/bin/env bash
# The documented "move a database between providers" (legacy-import.md section 5) as far as the CLI goes:
# dump a registered nonprod target with its exponetdb schema, restore into a NEW database, decommission the old target, register the new database.
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
P=55418
add_target rhmv pg18 nonprod 2>&1 | tail -1
SU() { runuser -u postgres -- psql -X -q -p $P -d postgres -v ON_ERROR_STOP=1 "$@"; }
runuser -u postgres -- psql -X -q -p $P -d lab_rhmv -c "create table public.moved_marker (id int primary key); insert into public.moved_marker values (1)" 
SU -c "create database lab_rhmv2 OWNER lab_owner"
runuser -u postgres -- bash -c "pg_dump -p $P -Fc lab_rhmv | pg_restore -p $P -d lab_rhmv2 --no-owner --role=lab_owner" 2>&1 | tail -1
echo "--- decommission the old target"
TAIL=8 tm mv-decommission exdb target decommission lab/platform/rhmv --reason moved_to_new_database --apply
echo "--- register the new database in the old target's environment"
CL=$(stack_id cluster_pg18)
human call POST /api/v1/clusters/$CL/databases '{"name":"lab_rhmv2"}' | cut -c1-200
PL=$(human call POST /api/v1/clusters/$CL/databases '{"name":"lab_rhmv2"}' | jq -r '.body.id'); echo "db plan $PL"; human apply "$PL" | cut -c1-120
sleep 2
DBID=$(human call GET /api/v1/clusters/$CL/databases | jq -r '.body.items[] | select(.name=="lab_rhmv2") | .id')
TAIL=8 tm mv-register exdb target register --project "$(stack_id project)" --environment "$(stack_id env_rhmv)" --database "$DBID"
