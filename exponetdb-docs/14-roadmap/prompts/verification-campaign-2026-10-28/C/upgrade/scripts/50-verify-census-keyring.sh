cd /srv/work/s3-infra/s3 && . ./lib.sh && s3_release new
echo "--- control-store status (exdb_serve login, new build)"; cs_status 2>&1 | jq -c '{status: .state.status, installationId, bundles: (.state.applied // [] | length)}' 2>/dev/null || cs_status 2>&1 | head -5
echo "--- keyring status"; ( set -a; . "${EXSTACK_STATE}/env/operator-worker.env"; set +a; node_run keyring status 2>&1 | head -12 )
echo "--- audit verify"; ( set -a; . "${EXSTACK_STATE}/env/operator-worker.env"; set +a; node_run audit verify 2>&1 | head -12 )
echo "--- census after"; bash counts.sh postup preup 2>&1 | tail -1
bash diff-census.sh preup postup > /srv/work/s3/logs/census/preup-vs-postup.tsv; awk -F'\t' 'NR>1 && ($5!=0 || $6!~/SAME|n\/a/) {print}' /srv/work/s3/logs/census/preup-vs-postup.tsv
echo "tables hashed: $(awk -F'\t' 'NR>1 && $6=="SAME"' /srv/work/s3/logs/census/preup-vs-postup.tsv | wc -l) SAME, $(awk -F'\t' 'NR>1 && $6 ~ /DIFFERENT/' /srv/work/s3/logs/census/preup-vs-postup.tsv | wc -l) DIFFERENT"
