#!/usr/bin/env bash
# Task B (iii-b): the same data in a NEW cluster by pg_dumpall | psql (another system identifier), then the registered cluster is pointed at it.
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
CL=$(stack_id cluster_pg17); NEWDIR=/var/lib/postgresql/17/rs2
pg_createcluster 17 rs2 -p 55527 -d "$NEWDIR" --start-conf=manual >/dev/null 2>&1
for f in postgresql.conf pg_hba.conf pg_ident.conf server.crt server.key; do sed -e 's/exs5/rs2/g' -e 's/55417/55527/g' /etc/postgresql/17/exs5/$f > /etc/postgresql/17/rs2/$f; done
rm -rf /etc/postgresql/17/rs2/conf.d; cp -a /etc/postgresql/17/exs5/conf.d /etc/postgresql/17/rs2/conf.d
chown postgres:postgres /etc/postgresql/17/rs2/*; chmod 600 /etc/postgresql/17/rs2/server.key /etc/postgresql/17/rs2/pg_hba.conf
cat >> "$NEWDIR/postgresql.auto.conf" <<'CONF'
wal_level = 'logical'
shared_preload_libraries = 'pg_stat_statements'
CONF
systemctl start postgresql@17-rs2.service; sleep 4
echo "system identifiers: old line $(runuser -u postgres -- psql -X -Atq -p 55537 -d postgres -c 'select system_identifier from pg_control_system()'), restored copy (physical) same as above; logical copy $(runuser -u postgres -- psql -X -Atq -p 55527 -d postgres -c 'select system_identifier from pg_control_system()')"
# every database except the big one, and all roles (passwords included: the verifiers travel in pg_dumpall)
t0=$(date +%s.%N)
runuser -u postgres -- bash -c 'pg_dumpall -p 55537 --globals-only | psql -X -q -p 55527 -d postgres >/dev/null 2>&1; for d in lab_rhprod lab_rhrep; do psql -X -q -p 55527 -d postgres -c "create database $d owner lab_owner"; pg_dump -p 55537 -Fc $d | pg_restore -p 55527 -d $d --no-owner --role=lab_owner 2>/dev/null; done'
echo "logical copy of two databases in $(echo "$(date +%s.%N) - $t0" | bc | cut -c1-5) s"
tm lg-endpoint-add-plan exdb cluster endpoint add "$CL" --label logical --kind private --host 127.0.0.1 --port 55527 --tls-server-name pg17.exdb.test >/dev/null
/srv/work/s5/rehearsal/prod_apply.sh "$(grep -o 'pln_[A-Z0-9]*' "$L/lg-endpoint-add-plan.log" | head -1)" lg-add 2>&1 | tail -3 | cut -c1-200
sleep 10
exdb health lab/platform/rhprod 2>&1 | sed -n 5,30p | cut -c1-180
