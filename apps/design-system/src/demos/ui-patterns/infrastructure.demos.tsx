import { ClusterCard, NodeCard } from '@exponetdb/ui-patterns'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, NOW } from './clock.ts'

const CAPABILITIES = [
  'postgres.status',
  'postgres.config.read',
  'postgres.config.apply',
  'backup.list',
  'backup.run',
  'logs.read',
  'host.metrics.read',
  'cert.inspect',
  'cert.rotate',
  'packages.list',
]

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/node-card/healthy',
    title: 'Node card: version, heartbeat, capabilities and health with its source',
    render: () => (
      <NodeCard
        name="db-eu-01"
        agentVersion="1.4.2"
        expectedAgentVersion="1.4.2"
        lastHeartbeatAt={minutesAgo(0.4)}
        capabilities={CAPABILITIES}
        maxCapabilities={5}
        state="healthy"
        source="agent_reported"
        observedAt={minutesAgo(0.4)}
        now={NOW}
      />
    ),
  },
  {
    id: 'ui-patterns/node-card/version-skew',
    title: 'Node card with version skew: the agent is older than the version ExponetDB expects',
    render: () => (
      <NodeCard
        name="db-eu-02"
        agentVersion="1.3.9"
        expectedAgentVersion="1.4.2"
        lastHeartbeatAt={minutesAgo(3)}
        capabilities={CAPABILITIES.slice(0, 4)}
        state="degraded"
        source="agent_reported"
        observedAt={minutesAgo(3)}
        now={NOW}
      />
    ),
  },
  {
    id: 'ui-patterns/node-card/no-heartbeat',
    title:
      'Node card with no heartbeat: the card says none was received, and the health is unknown',
    render: () => (
      <NodeCard
        name="db-eu-03"
        agentVersion="1.4.2"
        lastHeartbeatAt={null}
        capabilities={[]}
        state="unknown"
        now={NOW}
      />
    ),
  },
  {
    id: 'ui-patterns/node-card/hostile',
    title: 'Node card with hostile self-reported strings: marked as text',
    render: () => (
      <NodeCard
        name={'db\u{202E}-eu-04\u{200B}'}
        agentVersion={'1.4.2\u{202E}9.9.9'}
        expectedAgentVersion="1.4.2"
        lastHeartbeatAt={minutesAgo(1)}
        capabilities={['postgres.status', 'backup.run\u{200B}.extra']}
        state="unhealthy"
        source="agent_reported"
        observedAt={minutesAgo(1)}
        now={NOW}
      />
    ),
  },
  {
    id: 'ui-patterns/cluster-card/primary',
    title: 'Cluster card: PostgreSQL version, role and the number of placements',
    render: () => (
      <ClusterCard
        name="pg-main"
        postgresVersion="17.2"
        clusterRole="primary"
        placements={14}
        state="healthy"
        source="live"
        observedAt={minutesAgo(2)}
        now={NOW}
      />
    ),
  },
]
