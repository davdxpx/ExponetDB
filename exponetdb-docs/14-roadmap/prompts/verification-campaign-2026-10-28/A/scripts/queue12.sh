#!/bin/bash
# Phase 12: the agent-capabilities host test repeated alone (the next main commit failed it once in CI with NODE_OFFLINE)
S=/srv/work/bin/step.sh; N=/srv/work/new; RT=/srv/work/rt
source /srv/work/env.sh
cd $N
for i in 1 2; do
  rm -rf $RT/exdb-node
  EXDB_NODE_AGENT_USER="root exdbagent" bash tooling/dev/node-clusters.sh $RT/exdb-node > $RT/clusters.env 2> /srv/work/logs/n-agentcaps-rep$i-clusters.err
  eval "$(cat $RT/clusters.env)"
  bash /srv/work/bin/infra-up.sh pg > /srv/work/logs/infra-up-agentcaps-rep$i.log 2>&1
  source /srv/work/infra.env
  EXDB_NODE_E2E_AGENT_USER=exdbagent nice $S n-agentcaps-rep$i $N/apps/server bun run test:host test/agent-capabilities.host.test.ts
done
echo done-phase12 >> /srv/work/logs/summary.txt
