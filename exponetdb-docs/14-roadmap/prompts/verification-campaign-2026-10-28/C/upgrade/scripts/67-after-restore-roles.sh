cd /srv/work/s3-infra/s3 && . ./lib.sh && s3_release old
role_versions
exdb node list 2>&1 | sed -n 4,7p
bash counts.sh postrestore pre >/dev/null 2>&1; echo "--- restored store vs the census taken at dump time (label pre):"; bash diff-census.sh pre postrestore | awk -F'\t' 'NR==1 || $5!=0 || $6 ~ /DIFFERENT/' | head -20
echo "--- agent journal since the restore:"; journalctl --no-pager -o cat -u exponetdb-node --since "20:04:15" | cut -c1-300 | tail -8
psql_control -c '\d control.process_heartbeats' | head -20
