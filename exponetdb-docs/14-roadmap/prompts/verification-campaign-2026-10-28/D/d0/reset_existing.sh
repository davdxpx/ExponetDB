#!/bin/sh
# Rebuilds the "existing installation" database of d0-pg: bundles up to the pre-PR #46 head, then the three new ones.
set -e
cd "$(dirname "$0")"
docker exec d0-pg psql -U postgres -q -c 'DROP DATABASE IF EXISTS exponetdb_control WITH (FORCE)'
docker exec -i d0-pg psql -U postgres -q -c 'CREATE DATABASE exponetdb_control WITH TEMPLATE template0 ENCODING '"'"'UTF8'"'"' LC_COLLATE '"'"'C'"'"' LC_CTYPE '"'"'C'"'"''
docker exec -i d0-pg psql -U postgres -q <<'SQL'
REVOKE ALL ON DATABASE exponetdb_control FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE exponetdb_control TO exdb_migrate;
GRANT CONNECT ON DATABASE exponetdb_control TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;
ALTER ROLE exdb_migrate IN DATABASE exponetdb_control SET search_path = '';
ALTER ROLE exdb_serve IN DATABASE exponetdb_control SET search_path = '';
ALTER ROLE exdb_worker IN DATABASE exponetdb_control SET search_path = '';
ALTER ROLE exdb_gateway IN DATABASE exponetdb_control SET search_path = '';
ALTER ROLE exdb_audit_maint IN DATABASE exponetdb_control SET search_path = '';
\connect exponetdb_control
DROP SCHEMA IF EXISTS public;
SQL
python3 apply_bundles.py exponetdb_control up --until 01M5X840BP8JXGEQGS0PHPTB58 | tail -1
python3 apply_bundles.py exponetdb_control up --from-after 01M5X840BP8JXGEQGS0PHPTB58
python3 apply_bundles.py exponetdb_control verify | tail -1
