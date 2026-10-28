. /srv/work/r2/ftlib.sh
id exdbagent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin exdbagent
EXDB_NODE_PG_VERSIONS=17 EXDB_NODE_AGENT_USER="root exdbagent" bash /srv/work/r2/new/tooling/dev/node-clusters.sh /srv/work/r2/nodecl > /srv/work/r2/clusters.env 2>/srv/work/r2/logs/nodeclusters.err
eval "$(cat /srv/work/r2/clusters.env)"
export EXDB_NODE_E2E_AGENT_USER=exdbagent EXDB_LAB_RUN_DIR=/srv/work/r2/lab-runs
test -d /run/systemd/system && echo "systemd present"
hostrun() { # side file
  side=$1; f=$2
  (cd /srv/work/r2/$side/apps/server && bun run test:host $f 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "R2-|Test Files|Tests  |✓|×|FAIL|AssertionError|expected|HBA_WOULD" | head -${HL:-40})
}
echo "##### NEW hba (acceptance: plan-time refusal)"
hostrun new test/host/hba.host.test.ts
echo "##### OLD hba with the NEW test copied (fails-before)"
ft_reset; ft_copy apps/server/test/host/hba.host.test.ts
hostrun old test/host/hba.host.test.ts
ft_reset
echo "##### NEW probe E6/E10/E2"
cp /srv/work/r2/probes/r2-e2e6.host.test.ts /srv/work/r2/new/apps/server/test/host/
HL=60 hostrun new test/host/r2-e2e6.host.test.ts
rm -f /srv/work/r2/new/apps/server/test/host/r2-e2e6.host.test.ts
echo "##### OLD probe E6/E10/E2"
cp /srv/work/r2/probes/r2-e2e6.host.test.ts /srv/work/r2/old/apps/server/test/host/
HL=60 hostrun old test/host/r2-e2e6.host.test.ts
rm -f /srv/work/r2/old/apps/server/test/host/r2-e2e6.host.test.ts
echo HOST1-DONE
