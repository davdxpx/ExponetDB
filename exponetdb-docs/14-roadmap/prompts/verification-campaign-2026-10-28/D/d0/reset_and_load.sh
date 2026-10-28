#!/bin/sh
# Rebuilds the existing-installation database and loads both fixtures. exploratory.
set -e
cd "$(dirname "$0")"
./reset_existing.sh > /dev/null
docker exec -i d0-pg psql -X -U postgres -d exponetdb_control -q < fixture.sql > /dev/null
docker exec -i d0-pg psql -X -U postgres -d exponetdb_control -q < fixture2.sql > /dev/null
echo "fixtures loaded"
