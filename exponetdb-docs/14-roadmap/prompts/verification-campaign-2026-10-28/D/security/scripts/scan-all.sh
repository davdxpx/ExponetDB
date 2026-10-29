#!/usr/bin/env bash
# S4: search every sink for the canaries (all forms). Prints counts per sink only; hits go to $L4/hits.tsv (id, form, count; never a value).
# usage: scan-all.sh <round label>
source /srv/work/s4/env.sh
set -u
ROUND=${1:-r1}
cd "$S4"
refresh_creds; python3 "$S4/gen-canaries.py" >/dev/null
P="$S4/patterns.txt"
sf() { grep -raoF --null -f "$P" "$@" 2>/dev/null; }          # file mode
S() { echo "[$ROUND] $*"; }
# 1. journal: everything, in json (field values included)
journalctl --no-pager -o json 2>/dev/null | scan_stream "$ROUND:journal-all"
for u in exstack-serve exstack-worker exstack-gateway exponetdb-node exponetdb-node-helper docker; do
  journalctl --no-pager -o verbose -u $u.service 2>/dev/null | scan_stream "$ROUND:journal-$u"
done
# 2. logs, tmp, home, crash
sf /var/log /var/crash /tmp /var/tmp /root /home /run 2>/dev/null --exclude-dir=.bun --exclude-dir=node_modules --exclude=hits.tsv | python3 "$S4/attr.py" "$ROUND:var-log-tmp-home-crash" --files
sf /srv/work/logs-s1 /srv/work/s1/logs 2>/dev/null | python3 "$S4/attr.py" "$ROUND:kit-logs(s1)" --files
sf $L4/cli $L4/api $L4/sweep $L4/mcp 2>/dev/null | python3 "$S4/attr.py" "$ROUND:api-cli-responses" --files
# 3. processes: ps, cmdline as nobody, environ as nobody (readable?) and as root
ps -eo pid,user,args -ww | scan_stream "$ROUND:ps-args"
runuser -u nobody -- sh -c 'for p in /proc/[0-9]*; do tr "\0" "\n" <$p/cmdline 2>/dev/null; done' 2>/dev/null | scan_stream "$ROUND:proc-cmdline-nobody"
runuser -u nobody -- sh -c 'for p in /proc/[0-9]*; do tr "\0" "\n" <$p/environ 2>/dev/null; done' 2>/dev/null | scan_stream "$ROUND:proc-environ-nobody"
{ for p in /proc/[0-9]*; do tr "\0" "\n" <$p/environ 2>/dev/null; done; } 2>/dev/null | scan_stream "$ROUND:proc-environ-root(info)"
# 4. docker
docker inspect $(docker ps -aq) 2>/dev/null | scan_stream "$ROUND:docker-inspect(kit env)"
for c in $(docker ps -aq); do docker logs $c 2>&1; done | scan_stream "$ROUND:docker-logs"
# 5. Control Store: full dump (all schemas, rows in COPY text) and the raw data files
mkdir -p $L4/dumps; D=$L4/dumps/cs-$ROUND.sql.gz
( umask 077; docker exec -e PGPASSWORD="$(cat ${EXSTACK_STATE}/control.superuser)" ${EXSTACK_CONTROL_NAME} pg_dumpall -h 127.0.0.1 -U "$(_stk_super)" | gzip -c > $D )
gzip -dc $D | wc -c | sed "s/^/[$ROUND] control-store dump bytes: /"
gzip -dc $D | scan_stream "$ROUND:control-store-pg_dumpall"
sf "${EXSTACK_CONTROL_DATA}" | python3 "$S4/attr.py" "$ROUND:control-store-raw-datadir(wal+heap)" --files
# 6. node agent state, helper ledger, engine dirs
sf /srv/work/s1/audit-export | python3 "$S4/attr.py" "$ROUND:audit-export-dir" --files
sf /var/lib/exponetdb-node /var/lib/exponetdb-node-engine /etc/exponetdb-node --exclude=keys.json | python3 "$S4/attr.py" "$ROUND:node-agent-state+helper-ledger" --files
# 7. target database side: server logs and statement views
sf /var/log/postgresql | python3 "$S4/attr.py" "$ROUND:target-pg-logs" --files
for v in 16 17 18; do
  port=$((55400+v))
  for db in $(psql_target pg$v -Atc "select datname from pg_database where datallowconn" 2>/dev/null); do
    PGDATABASE=$db psql_target pg$v -Atc "select query from pg_stat_activity union all select query from pg_stat_statements" 2>/dev/null | scan_stream "$ROUND:target-pg$v-$db-statements"
  done
done
# 8. the rest of the disk (everything else is binaries and caches), config
sf /etc --exclude=50-s4-host-secrets.conf --exclude=pg_hba.conf --exclude=pgbackrest.conf --exclude=restic-password --exclude=server.key --exclude='*.key' | python3 "$S4/attr.py" "$ROUND:etc(not the planted files)" --files
sf /srv/work/s1/projects /srv/work/s1/build/bundle | python3 "$S4/attr.py" "$ROUND:project-bundles+build" --files
echo "[$ROUND] done"
