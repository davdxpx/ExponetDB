#!/usr/bin/env bash
# S4 task 1, step 2: submit the planted credentials through the product's own flows.
source /srv/work/s4/env.sh
set -u
cd "$S4"
C16=$(stack_id cluster_pg16); C17=$(stack_id cluster_pg17); C18=$(stack_id cluster_pg18)
r() { s4ts s4/req.ts "$@" 2>&1 | tail -1; }
echo "-- registered target credentials (write-only submission)"
r cred-pg16-migrator --reauth POST /api/v1/clusters/$C16/credentials/migrator '{"password":"@@C2-migrator-password@@"}'
r cred-pg16-reader --reauth POST /api/v1/clusters/$C16/credentials/reader '{"password":"@@C2-reader-password@@"}'
sleep 6
r cred-list-pg16 GET /api/v1/clusters/$C16/credentials
jq -c '.body.items[]|{accessRole,state}' $L4/api/cred-list-pg16.json | tr '\n' ' '; echo
echo "-- wrong password path (verifier role of pg18 gets a password PostgreSQL does not have)"
r cred-pg18-verifier-wrong --reauth POST /api/v1/clusters/$C18/credentials/verifier '{"password":"@@C2-wrong-password@@"}'
sleep 8
r cred-list-pg18 GET /api/v1/clusters/$C18/credentials
jq -c '.body.items[]|{accessRole,state,lastError:(.lastError//.errorCode//null)}' $L4/api/cred-list-pg18.json | tr '\n' ' '; echo
echo "-- consumer role verifier through the node (pg17)"
r verifier-plan --reauth --wait --approve POST /api/v1/clusters/$C17/role-verifiers '{"role":"s4_canary_app","verifier":"@@C1-verifier@@"}'
psql_target pg17 -Atc "select rolname, rolpassword is not null from pg_authid where rolname='s4_canary_app'"
