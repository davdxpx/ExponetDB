#!/usr/bin/env bash
# Task B (v): a logical replication SUBSCRIBER as a registered target (lab/platform/rh18, PG18), the publisher is the PG17 line (supabase_realtime of lab_rhstg).
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
PUB=55537; SUB=55418
S() { runuser -u postgres -- psql -X -Atq -p "$1" -d "$2" -v ON_ERROR_STOP=1 -c "$3"; }
S $SUB lab_rh18 "CREATE SUBSCRIPTION rh_sub CONNECTION 'host=/var/run/postgresql port=$PUB dbname=lab_rhstg user=postgres' PUBLICATION supabase_realtime WITH (copy_data = false)" 2>&1 | tail -1
sleep 3
echo "slot on the publisher: $(S $PUB lab_rhstg "select slot_name||' active='||active||' restart_lsn='||restart_lsn from pg_replication_slots where slot_type='logical'")"
echo "--- the product's view of the subscriber target"
TAIL=12 tm sub-target-show exdb target show lab/platform/rh18
exdb health lab/platform/rh18 2>&1 | sed -n 5,25p | cut -c1-160
TAIL=6 tm sub-drift exdb drift check lab/platform/rh18
echo "--- a row on the publisher that the subscriber cannot take (publisher has calendar_items.flag, the subscriber not yet)"
S $PUB lab_rhstg "insert into public.calendar_items (org_id, account_id, title, flag) values (md5('1')::uuid, 1, 'replicated?', true)" 
sleep 6
echo "subscription errors on the subscriber: $(S $SUB lab_rh18 "select apply_error_count||' errors' from pg_stat_subscription_stats where subname='rh_sub'")"
echo "slot after: $(S $PUB lab_rhstg "select slot_name||' active='||active||' wal retained (bytes)='||pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) from pg_replication_slots where slot_type='logical'")"
echo "--- the product still plans and applies on the subscriber"
E2=$(cat "$L/e2.id")
TAIL=5 tm sub-plan exdb migration plan "$E2" --target lab/platform/rh18
PL=$(grep -o 'pln_[A-Z0-9]*' "$L/sub-plan.log" | head -1)
TAIL=6 tm sub-apply exdb plan apply "$PL" --wait
sleep 8
echo "subscription errors after the product's apply (it added the column): $(S $SUB lab_rh18 "select apply_error_count from pg_stat_subscription_stats where subname='rh_sub'") ; rows on the subscriber: $(S $SUB lab_rh18 "select count(*) from public.calendar_items")"
