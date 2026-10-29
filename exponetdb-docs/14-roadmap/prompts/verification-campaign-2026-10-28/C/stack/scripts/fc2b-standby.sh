#!/usr/bin/env bash
# fail-closed step 2, the real thing: the Control Store is a hot standby that nobody promoted (every write: SQLSTATE 25006).
# default_transaction_read_only does not stop the product (it opens write transactions with an explicit READ WRITE), see fc2.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc2b.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
D=${EXSTACK_CONTROL_DATA}; C=$EXSTACK_CONTROL_NAME
bearer
echo "== baseline $(mut)"
docker exec $C bash -c 'mkdir -p /var/lib/postgresql/data/standby && chown postgres:postgres /var/lib/postgresql/data/standby && chmod 700 /var/lib/postgresql/data/standby'
docker exec -u postgres $C pg_basebackup -h 127.0.0.1 -U "$(_stk_super)" -D /var/lib/postgresql/data/standby -R -X stream -c fast 2>&1 | tail -2
[ -f $D/standby/standby.signal ] || { echo "basebackup failed; abort"; exit 1; }
echo "== swap in the standby copy as the data directory (stop container, move, start) $(now)"
docker stop $C >/dev/null
mv $D/pgdata $D/pgdata.primary && mv $D/standby $D/pgdata
docker start $C >/dev/null
t0
for i in $(seq 1 30); do docker exec $C pg_isready -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done
echo "standby up after t=$(el): in_recovery=$(docker exec -e PGPASSWORD=$(cat ${EXSTACK_STATE}/control.superuser) $C psql -h 127.0.0.1 -U "$(_stk_super)" -d exponetdb_control -Atc 'select pg_is_in_recovery()')"
timeline 100 3 15 40 80
echo "-- serve log events:"; logs_since serve "-2 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.errorCode,.errorName,.code]|@tsv' | sort | uniq -c | sort -rn | head
echo "-- healthz/detail serve: $(hdetail $S | jq -c '[.status, (.checks[]|select(.status!="pass")|{name,status,reason})]')"
echo "-- /installation/health: $(bearer; rest GET /api/v1/installation/health | head -1) $(jq -c '{state}' /dev/shm/s6out.last)"
echo "== PROMOTE $(now)"
t0
docker exec -u postgres $C pg_ctl promote -D /var/lib/postgresql/data/pgdata 2>&1 | tail -1
for i in $(seq 1 60); do r=$(hc $S); printf 't=%s serve=%s worker=%s gw=%s\n' "$(el)" "$r" "$(hc $W)" "$(hc $G)"; [ "$r" = 200 ] && [ "$(hc $W)" = 200 ] && break; sleep 1; done
bearer; mut
rm -rf $D/pgdata.primary
