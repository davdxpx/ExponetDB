#!/bin/sh
# A database at the pre-PR #46 head (bundles up to excused-value-digests) with the same fixtures. exploratory.
set -e
cd "$(dirname "$0")"
docker exec d0-pg psql -U postgres -q -c 'DROP DATABASE IF EXISTS exponetdb_pre WITH (FORCE)'
docker exec d0-pg psql -U postgres -q -c "CREATE DATABASE exponetdb_pre WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
docker exec -i d0-pg psql -U postgres -q <<'SQL'
REVOKE ALL ON DATABASE exponetdb_pre FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE exponetdb_pre TO exdb_migrate;
GRANT CONNECT ON DATABASE exponetdb_pre TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;
ALTER ROLE exdb_migrate IN DATABASE exponetdb_pre SET search_path = '';
ALTER ROLE exdb_serve IN DATABASE exponetdb_pre SET search_path = '';
ALTER ROLE exdb_worker IN DATABASE exponetdb_pre SET search_path = '';
ALTER ROLE exdb_gateway IN DATABASE exponetdb_pre SET search_path = '';
ALTER ROLE exdb_audit_maint IN DATABASE exponetdb_pre SET search_path = '';
\connect exponetdb_pre
DROP SCHEMA IF EXISTS public;
SQL
python3 apply_bundles.py exponetdb_pre up --until 01M5X840BP8JXGEQGS0PHPTB58 | tail -1
docker exec -i d0-pg psql -X -U postgres -d exponetdb_pre -q < fixture.sql > /dev/null
echo "pre-PR database ready"
