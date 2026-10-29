cd /srv/work/s3-infra/s3 && . ./lib.sh && s3_release new
dir="$(new_project post-upgrade)"
mkb "$dir" post-upgrade-widgets <<'SQL' >/dev/null
CREATE TABLE public.post_upgrade_widgets (id int PRIMARY KEY, label text);
GRANT SELECT ON public.post_upgrade_widgets TO lab_owner;
SQL
for t in staging dev16 dev18; do mplan "$dir" "lab/platform/$t" >/dev/null; mapply "$PLAN_ID" --wait >/dev/null; echo "new migration on $t: $(op_state "$OP_ID")"; done
echo "=== node"
exdb node list 2>&1 | head -8
psql_control -c '\d nodes.nodes' | head -30 | cut -c1-110
ctl_sql "select node_id, state, last_heartbeat_at, now()-last_heartbeat_at as age from nodes.nodes" 2>&1 | head
echo "--- gateway journal since the upgrade (agent connections)"; journal gateway --since "20:00:30" | cut -c1-260 | head -30
echo "--- agent journal around the upgrade"; journalctl --no-pager -o cat -u exponetdb-node --since "20:00:20" --until "20:03:00" | cut -c1-260 | head -30
