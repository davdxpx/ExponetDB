#!/usr/bin/env bash
# keys step 8 (C1-7): the worker's lease belief uses the wall clock. A 90 s apply; at 20 s the Control Store port is dropped for 12 s (one
# or two lease renewals fail) and the worker's clock steps +300 s (libfaketime on the worker only). Does the step abort though the
# database lease is still held (30 s)?
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/ktlease.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
ftw() { echo "$1" >/srv/work/s6/ft-worker; }
T="$(add_target s6lease pg16)"; db=lab_s6lease
PGDATABASE="$db" psql_target pg16 -q -c "CREATE SEQUENCE public.exec_seq; GRANT USAGE ON SEQUENCE public.exec_seq TO lab_owner"
dir="$(new_project s6lease)"
id="$(mkb "$dir" lease <<SQL
SELECT nextval('public.exec_seq');
CREATE TABLE public.ls_first (id int PRIMARY KEY);
SELECT pg_sleep(60);
CREATE TABLE public.ls_a (id int PRIMARY KEY);
GRANT SELECT ON public.ls_a TO lab_owner;
SQL
)"
mplan "$dir" "$T" || exit 1
bearer; mapply "$PLAN_ID" --no-wait; op="$OP_ID"
sleep 20; echo "op before: $(op_state $op); lease: $(ctl_sql "select lease_owner is not null, lease_expires_at - clock_timestamp() from operations.operations where operation_id='$op'")"
ftw +300; net_block ${EXSTACK_PORT_CONTROL} drop; echo "store port dropped + worker clock +300 s at $(now)"; sleep 12; net_unblock; ftw +0; echo "restored at $(now)"
last=""; end=$(( $(date +%s) + 150 ))
while [ "$(date +%s)" -lt "$end" ]; do cur="$(op_state $op)"; [ "$cur" != "$last" ] && { echo "  $(now) $cur"; last="$cur"; }; case "${cur%% *}" in succeeded|failed|verification_failed|needs_attention|canceled) break;; esac; sleep 2; done
led="$(PGDATABASE="$db" psql_target pg16 -Atc "select count(*) from exponetdb.schema_migrations where migration_id='$id'")"; execs="$(PGDATABASE="$db" psql_target pg16 -Atc "SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM public.exec_seq")"
echo "result: op=[$cur] ledger rows=$led first statement executed ${execs}x"
echo "events: $(psql_control -At -c "select kind||':'||coalesce(to_state,'') from operations.operation_events where operation_id='$op' order by event_id" | tr '\n' ';' | cut -c1-600)"
echo "worker log: $(logs_since worker "-4 min" | jq -rc 'select(.level=="warn" or .level=="error")|[.msg,.code]|@tsv' | sort | uniq -c | head -5 | tr '\n' '|')"
