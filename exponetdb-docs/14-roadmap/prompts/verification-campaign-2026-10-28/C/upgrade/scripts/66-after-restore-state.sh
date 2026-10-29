cd /srv/work/s3-infra/s3 && . ./lib.sh && s3_release old
echo "=== whoami"; exdb whoami 2>&1 | head -12
echo "=== target list"; exdb target list 2>&1 | head -12
echo "=== migration status staging (ledger vs mirror)"; (cd /srv/work/s3/projects/upg && exdb migration status --target lab/platform/staging 2>&1 | head -30)
echo "=== node"; exdb node list 2>&1 | head -6
echo "=== counts: preup (before upgrade) vs prerestore vs now"
bash counts.sh postrestore preup >/dev/null 2>&1; bash diff-census.sh preup postrestore | awk -F'\t' 'NR==1 || $5!=0 || $6 ~ /DIFFERENT/' | head -30
echo "=== process heartbeats"; psql_control -At -c "select process_id, role, state, last_heartbeat_at from control.process_heartbeats order by started_at" 2>&1 | head -12
