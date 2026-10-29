#!/usr/bin/env bash
# S4 task 4 (I14): hostile bundle content applied to a nonprod target; the apply role must be unable, the refusal clear and audited,
# and nothing may reach the host or another target. Measures serve/worker CPU and RSS during every plan.
source /srv/work/s4/env.sh
cd $S4; refresh_creds
[ -n "${SKIP_ADD:-}" ] || add_target s4cont pg17 >/dev/null 2>&1; TP=lab/platform/s4cont; EVI=lab/platform/s4evi
rm -f /tmp/s4-copy-program /tmp/s4-cross* ; PGDATABASE=lab_s4evi psql_target pg17 -q -c 'DROP TABLE IF EXISTS public.s4_crossreach' 2>/dev/null
SERVE=$(systemctl show -p MainPID --value exstack-serve.service); WORK=$(systemctl show -p MainPID --value exstack-worker.service)
rss() { awk '/VmRSS/{printf "%d",$2/1024}' /proc/$1/status; }
cpu() { awk '{print $14+$15}' /proc/$1/stat; }
declare -A SQL
SQL[01-copy-to-program]="COPY (SELECT 'x') TO PROGRAM 'id > /tmp/s4-copy-program';"
SQL[02-copy-from-program]="CREATE TEMP TABLE s4t(l text); COPY s4t FROM PROGRAM 'echo from-program';"
SQL[03-pg-read-file]="CREATE TEMP TABLE s4t2 AS SELECT pg_read_file('/etc/passwd') AS f;"
SQL[04-lo-import]="SELECT lo_import('/etc/passwd');"
SQL[05-create-ext-plpython3u]="CREATE EXTENSION plpython3u;"
SQL[06-create-ext-plperlu]="CREATE EXTENSION plperlu;"
SQL[07-alter-system]="ALTER SYSTEM SET work_mem = '5MB';"
SQL[08-dblink-other-target]="CREATE EXTENSION dblink; SELECT dblink_exec('host=127.0.0.1 port=55417 dbname=lab_s4evi user=postgres', 'CREATE TABLE public.s4_crossreach(i int)');"
SQL[09-fdw-other-target]="CREATE EXTENSION postgres_fdw; CREATE SERVER s4x FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '127.0.0.1', port '55417', dbname 'lab_s4evi'); CREATE USER MAPPING FOR CURRENT_USER SERVER s4x OPTIONS (user 'postgres');"
SQL[10-psql-connect-meta]=$'\\connect lab_s4evi\nCREATE TABLE public.s4_crossreach(i int);'
SQL[11-set-role-postgres]="SET ROLE postgres; CREATE TABLE public.s4_as_super(i int);"
SQL[12-session-authorization]="SET SESSION AUTHORIZATION postgres; CREATE TABLE public.s4_as_super2(i int);"
SQL[13-drop-exponetdb-schema]="DROP SCHEMA exponetdb CASCADE;"
SQL[14-forge-ledger-row]="INSERT INTO exponetdb.schema_migrations(migration_id, name, checksum, applied_seq) SELECT '01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'forged', 'sha256:c1:forged', 999;"
SQL[15-truncate-ledger]="TRUNCATE exponetdb.schema_migrations;"
SQL[16-escalate-migrator]="ALTER ROLE exponetdb_migrator SUPERUSER; GRANT pg_execute_server_program TO exponetdb_migrator;"
SQL[17-create-superuser-role]="CREATE ROLE s4_evil SUPERUSER LOGIN;"
SQL[18-untrusted-language-fn]="CREATE FUNCTION public.s4_evil() RETURNS text LANGUAGE plpython3u AS \$\$ import os; return os.popen('id').read() \$\$;"
printf '%-30s %-10s %-34s %-26s %s\n' case plan apply "serve/worker CPU s, RSS MiB" "host/other-target effect"
for k in $(printf '%s\n' "${!SQL[@]}" | sort | grep -E "${ONLY:-.}"); do
  P=$(new_project s4c-$k 2>/dev/null); mkb $P "s4c-${k#*-}" >/dev/null <<<"${SQL[$k]}"
  s0=$(cpu $SERVE); w0=$(cpu $WORK); peak=0
  ( while :; do r=$(( $(rss $SERVE) > $(rss $WORK) ? $(rss $SERVE) : $(rss $WORK) )); echo $r; sleep 0.1; done > $L4/rss.$k ) & SPID=$!
  planline=$(mplan $P $TP 2>&1)
  planst=$(sed -n 's/.*state=\([^ ]*\) decision=\([^ ]*\) error=\([^ ]*\).*/\1\/\2\/\3/p' <<<"$planline")
  applyres="-"
  if grep -q 'state=active' <<<"$planline"; then pid=$(sed -n 's/^plan=\([^ ]*\).*/\1/p' <<<"$planline"); applyres=$(mapply $pid 2>&1 | sed -n 's/.*error=\([^ ]*\) store: \(.*\)/\1 \2/p' | cut -c1-60); fi
  kill $SPID 2>/dev/null; wait $SPID 2>/dev/null
  peak=$(sort -n $L4/rss.$k | tail -1); rm -f $L4/rss.$k
  eff=""
  [ -e /tmp/s4-copy-program ] && eff="$eff HOST-FILE-WRITTEN"
  [ "$(PGDATABASE=lab_s4evi psql_target pg17 -Atc "select to_regclass('public.s4_crossreach') is not null" 2>/dev/null)" = t ] && eff="$eff CROSS-TARGET-TABLE"
  [ "$(PGDATABASE=lab_s4cont psql_target pg17 -Atc "select count(*) from pg_class where relname in ('s4_as_super','s4_as_super2')" 2>/dev/null)" != 0 ] && eff="$eff TABLE-AS-POSTGRES"
  [ "$(psql_target pg17 -Atc "select rolsuper from pg_roles where rolname in ('exponetdb_migrator')")" = t ] && eff="$eff MIGRATOR-SUPERUSER"
  [ "$(psql_target pg17 -Atc "select count(*) from pg_roles where rolname='s4_evil'")" != 0 ] && eff="$eff EVIL-ROLE"
  printf '%-30s %-10s %-34s %-26s %s\n' "$k" "$planst" "$applyres" "$(( ($(cpu $SERVE)-s0+$(cpu $WORK)-w0) / 100 )).$(( ($(cpu $SERVE)-s0+$(cpu $WORK)-w0) % 100 ))s ${peak}MiB" "${eff:-none}"
done
