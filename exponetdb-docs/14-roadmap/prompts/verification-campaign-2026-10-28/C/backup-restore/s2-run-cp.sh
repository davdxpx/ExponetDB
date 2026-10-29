# usage: s2-run-cp.sh TESTFILE TAG   (inside s2-host)
source /srv/work/r1/env-host.sh
export EXDB_NODE_E2E_AGENT_USER=exponetdb-node
cd /srv/work/r1/new/apps/server
S2_S3_FULL=${S2_S3_FULL:-} S2_CASES=${S2_CASES:-} S2_SPECIAL=${S2_SPECIAL:-} S2_TAG=$2 nice bunx vitest run --config vitest.host.config.ts --testTimeout=7200000 test/host/$1 > /srv/work/s2/logs/cp-$2.vitest 2>&1
echo "EXIT=$?" >> /srv/work/s2/logs/cp-$2.vitest
