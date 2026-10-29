cd /srv/work/s3-infra/s3 && . ./lib.sh && s3_release new
ro() { EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_serve)" node_run "$@"; }
echo "--- control-store status"; ro control-store status 2>&1 | head -30
echo "--- audit verify"; ro audit verify 2>&1 | head -12
