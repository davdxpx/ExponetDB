#!/usr/bin/env bash
# Task B (i) and (ii): clones and a rename of a managed database (lab/platform/rhprod = lab_rhprod on cluster 17), and what the product says.
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
SU() { runuser -u postgres -- psql -X -q -p 55417 -d postgres -v ON_ERROR_STOP=1 "$@"; }
kick() { SU -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='$1' and pid<>pg_backend_pid()" >/dev/null; }
marker() { runuser -u postgres -- psql -X -Atq -p 55417 -d "$1" -c "select 'marker in $1: '||coalesce((select string_agg(k||'='||v, ' ') from (select key as k, left(value::text, 40) as v from exponetdb.identity_marker, jsonb_each_text(to_jsonb(identity_marker.*)) limit 6) s), '?')" 2>&1 | head -2; }
echo "=== the identity marker of the managed database"
runuser -u postgres -- psql -X -Atq -p 55417 -d lab_rhprod -c "select table_name from information_schema.tables where table_schema='exponetdb' order by 1" | tr '\n' ' '; echo
runuser -u postgres -- psql -X -Atq -p 55417 -d lab_rhprod -c "select * from exponetdb.identity" 2>&1 | cut -c1-300 | head -3

echo; echo "=== (i-a) CREATE DATABASE ... TEMPLATE lab_rhprod, then register the clone as a second target"
kick lab_rhprod; sleep 1
t0=$(date +%s.%N)
SU -c "create database lab_rhclone TEMPLATE lab_rhprod OWNER lab_owner" && echo "template clone created in $(echo "$(date +%s.%N) - $t0" | bc | cut -c1-5) s"
echo "--- add_target (environment, database record, bootstrap script, target plan) for the clone:"
add_target rhclone pg17 nonprod 2>&1 | tail -6 | cut -c1-400

echo; echo "=== (i-b) pg_dump | pg_restore into a new database of the same cluster"
SU -c "create database lab_rhclone2 OWNER lab_owner"
runuser -u postgres -- bash -c "pg_dump -p 55417 -Fc lab_rhprod | pg_restore -p 55417 -d lab_rhclone2 --no-owner --role=lab_owner" 2>&1 | tail -3 | cut -c1-200
echo "--- add_target for the dump clone:"
add_target rhclone2 pg17 nonprod 2>&1 | tail -6 | cut -c1-400
