import { agentApi } from '@exponetdb/application'
import {
  AgentGateway,
  certificatePem,
  type GatewayPki,
  loadGatewayPki,
  mintGatewayIdentity,
} from '@exponetdb/nodes'
import type { HealthCheck } from '@exponetdb/observability'
import type { GatewayConfig } from '../config/env.ts'
import { type AgentListener, listenAgentApi } from '../interfaces/gateway/agent-listener.ts'
import type { RoleServices } from './role.ts'
import type { Runtime } from './runtime.ts'

/**
 * The gateway role's agent listener ([control-plane.md §5](../../../../exponetdb-docs/07-node-agent/control-plane.md#5-gateway)).
 * Without `EXPONETDB_GATEWAY_LISTEN` nothing listens. With it, the gateway
 * waits for the agent PKI (`exponetdb node-pki init`), then opens the
 * HTTP/2 mTLS listener with a TLS identity it mints in memory from the
 * server CA and replaces daily. Readiness says whether agents can connect.
 */

const PKI_RETRY_MS = 30_000
const IDENTITY_REFRESH_MS = 24 * 3_600_000

export interface GatewayComposition {
  readonly check: HealthCheck
  start(): Promise<void>
  stop(): Promise<void>
}

export function composeGateway(
  config: GatewayConfig,
  services: Pick<RoleServices, 'store' | 'keyring'>,
  runtime: Runtime,
): GatewayComposition {
  const log = runtime.logger
  let listener: AgentListener | undefined
  let state: 'off' | 'waiting_for_pki' | 'listening' | 'failed' =
    config.agentListen === undefined ? 'off' : 'waiting_for_pki'
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const open = async (pki: GatewayPki, endpoint: { host: string; port: number }) => {
    const gateway = new AgentGateway({
      store: services.store,
      pki,
      clock: runtime.clock,
      installationId: config.installationId,
    })
    listener = await listenAgentApi({
      host: endpoint.host,
      port: endpoint.port,
      identity: mintGatewayIdentity(pki, runtime.clock),
      clientRootPem: certificatePem(pki.rootCertificate),
      api: agentApi(gateway),
      logger: log.child({ component: 'agent_listener' }),
    })
    state = 'listening'
    log.info('gateway.agent_listener.open', { port: listener.port })
    const refresh = () => {
      timer = setTimeout(() => {
        try {
          listener?.setIdentity(mintGatewayIdentity(pki, runtime.clock))
          log.info('gateway.identity.renewed')
        } catch (error) {
          log.error('gateway.identity.renew_failed', { err: error })
        }
        refresh()
      }, IDENTITY_REFRESH_MS)
      timer.unref()
    }
    refresh()
  }

  const attempt = async (): Promise<void> => {
    const endpoint = config.agentListen
    if (endpoint === undefined || stopped) {
      return
    }
    try {
      const pki = await loadGatewayPki(services.store, services.keyring)
      if (pki === undefined) {
        log.warn('gateway.pki_missing', { reason: 'node_pki_init_required' })
      } else {
        await open(pki, endpoint)
        return
      }
    } catch (error) {
      state = 'failed'
      log.error('gateway.agent_listener.failed', { err: error })
    }
    if (!stopped) {
      timer = setTimeout(() => void attempt(), PKI_RETRY_MS)
      timer.unref()
    }
  }

  return {
    check: {
      name: 'agent_listener',
      severity: 'critical',
      run: async () =>
        state === 'off' || state === 'listening'
          ? { status: 'pass' }
          : { status: 'fail', reason: state },
    },
    start: attempt,
    async stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      await listener?.close(config.shutdownTimeoutMs / 2)
    },
  }
}
