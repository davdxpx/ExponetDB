#!/bin/bash
# Phase 5 on the NEW clone: node-pg, backup-lab, host scenarios (real systemd on this VM)
S=/srv/work/bin/step.sh; N=/srv/work/new; G=$N/agent/node; RT=/srv/work/rt
mkdir -p $RT /srv/work/results
cd $N
id exdbagent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin exdbagent
# --- node-pg job
rm -rf $RT/exdb-node
EXDB_NODE_AGENT_USER="root exdbagent" bash tooling/dev/node-clusters.sh $RT/exdb-node > $RT/clusters.env 2> /srv/work/logs/n-nodepg-clusters.err
cat $RT/clusters.env | sed 's/=.*/=<redacted>/' > /srv/work/logs/n-nodepg-clusters.env.names
eval "$(cat $RT/clusters.env)"
nice $S n-nodepg-wire-caps $G bash -c 'test -d /run/systemd/system && go test -race -count=1 -tags pgit ./internal/pgwire ./internal/capabilities'
bash /srv/work/bin/infra-up.sh pg > /srv/work/logs/infra-up-nodepg.log 2>&1
source /srv/work/infra.env
EXDB_NODE_E2E_AGENT_USER=exdbagent nice $S n-nodepg-agentcaps $N/apps/server bun run test:host test/agent-capabilities.host.test.ts -- --reporter=default --reporter=json --outputFile.json=/srv/work/results/host-agent-capabilities.json
# --- backup-lab job
nice $S n-backuplab-pglab $G go test -tags pglab -count=1 -run TestPglab -v ./internal/helper
nice $S n-backuplab-runbook $N bun run --cwd packages/backups test:lab
# --- host scenarios, one at a time, a fresh cluster and Control Store each
for sc in config enrollment hba roles-tls-credentials job-keys crash-points partition journal identity production secrets; do
  rm -rf $RT/exdb-node $RT/lab-runs
  EXDB_NODE_PG_VERSIONS=17 EXDB_NODE_AGENT_USER="root exdbagent" bash tooling/dev/node-clusters.sh $RT/exdb-node > $RT/clusters.env 2> /srv/work/logs/n-host-$sc-clusters.err
  eval "$(cat $RT/clusters.env)"
  bash /srv/work/bin/infra-up.sh pg > /srv/work/logs/infra-up-host-$sc.log 2>&1
  source /srv/work/infra.env
  EXDB_NODE_E2E_AGENT_USER=exdbagent EXDB_LAB_RUN_DIR=$RT/lab-runs nice $S n-host-$sc $N/apps/server bun run test:host test/host/$sc.host.test.ts -- --reporter=default --reporter=json --outputFile.json=/srv/work/results/host-$sc.json
  cat $RT/lab-runs/*.json > /srv/work/logs/n-host-$sc.record.json 2>/dev/null
done
echo done-phase5 >> /srv/work/logs/summary.txt
