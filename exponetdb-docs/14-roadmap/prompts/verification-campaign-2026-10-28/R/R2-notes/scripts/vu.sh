cd /srv/work/r2/new/agent/node/packaging
echo "### verify-units.sh as root"
bash verify-units.sh 2>&1 | tail -15; echo "rc=${PIPESTATUS[0]}"
