#!/usr/bin/env bash
# Task B (iv): a physical streaming standby (rs3, 55537) of the restored primary (rs1, 55517); the registered cluster is pointed at the standby
# first (read-only!), a plan and an apply are tried, then the standby is promoted and the same apply is tried again.
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
CL=$(stack_id cluster_pg17); NEWDIR=/var/lib/postgresql/17/rs3
ep_add() { # port label
  tm "rp-$2-add-plan" exdb cluster endpoint add "$CL" --label "$2" --kind private --host 127.0.0.1 --port "$1" --tls-server-name pg17.exdb.test >/dev/null
  /srv/work/s5/rehearsal/prod_apply.sh "$(grep -o 'pln_[A-Z0-9]*' "$L/rp-$2-add-plan.log" | head -1)" "rp-$2-add" 2>&1 | tail -2; }
ep_retire() { # endpoint id
  tm "rp-$1-retire-plan" exdb cluster endpoint retire "$CL" "$1" --reason replaced_by_standby >/dev/null
  /srv/work/s5/rehearsal/prod_apply.sh "$(grep -o 'pln_[A-Z0-9]*' "$L/rp-$1-retire-plan.log" | head -1)" "rp-$1-retire" 2>&1 | tail -2; }
pg_createcluster 17 rs3 -p 55537 -d "$NEWDIR" --start-conf=manual >/dev/null 2>&1; systemctl stop postgresql@17-rs3.service 2>/dev/null; rm -rf "$NEWDIR"
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_basebackup -h /var/run/postgresql -p 55517 -D "$NEWDIR" -R -X stream -c fast 2>&1 | tail -2
for f in postgresql.conf pg_hba.conf pg_ident.conf server.crt server.key; do sed -e 's/exs5/rs3/g' -e 's/55417/55537/g' /etc/postgresql/17/exs5/$f > /etc/postgresql/17/rs3/$f; done
rm -rf /etc/postgresql/17/rs3/conf.d; cp -a /etc/postgresql/17/exs5/conf.d /etc/postgresql/17/rs3/conf.d
chown postgres:postgres /etc/postgresql/17/rs3/*; chmod 600 /etc/postgresql/17/rs3/server.key /etc/postgresql/17/rs3/pg_hba.conf
echo "primary_conninfo = 'host=/var/run/postgresql port=55517 user=postgres'" >> "$NEWDIR/postgresql.auto.conf"; echo "archive_mode = 'off'" >> "$NEWDIR/postgresql.auto.conf"
chown -R postgres:postgres "$NEWDIR"; systemctl start postgresql@17-rs3.service; sleep 6
echo "standby in recovery: $(runuser -u postgres -- psql -X -Atq -p 55537 -d postgres -c 'select pg_is_in_recovery()'); streaming: $(runuser -u postgres -- psql -X -Atq -p 55517 -d postgres -c 'select count(*) from pg_stat_replication')"
RS1=$(exdb_json cluster endpoints "$CL" | jq -r '.data.items[] | select(.label=="rs1") | .id')
echo "--- point the registered cluster at the STANDBY (add standby endpoint, retire the primary's)"
ep_add 55537 standby; ep_retire "$RS1"
sleep 8
TAIL=12 tm rp-standby-show exdb target show lab/platform/rhstg
exdb health lab/platform/rhstg 2>&1 | sed -n 5,20p | cut -c1-160
E1=$(cat "$L/e1.id")
echo "--- plan and apply against the read-only standby"
TAIL=6 tm rp-standby-plan exdb migration plan "$E1" --target lab/platform/rhstg
PL=$(grep -o 'pln_[A-Z0-9]*' "$L/rp-standby-plan.log" | head -1)
TAIL=14 tm rp-standby-apply exdb plan apply "$PL" --wait
echo "--- promote the standby"
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl promote -D "$NEWDIR" >/dev/null 2>&1 || pg_ctlcluster 17 rs3 promote; sleep 4
echo "promoted: in recovery = $(runuser -u postgres -- psql -X -Atq -p 55537 -d postgres -c 'select pg_is_in_recovery()'), timeline $(runuser -u postgres -- psql -X -Atq -p 55537 -d postgres -c 'select timeline_id from pg_control_checkpoint()')"
sleep 6
TAIL=6 tm rp-promoted-plan exdb migration plan "$E1" --target lab/platform/rhstg
PL=$(grep -o 'pln_[A-Z0-9]*' "$L/rp-promoted-plan.log" | head -1)
TAIL=8 tm rp-promoted-apply exdb plan apply "$PL" --wait
