import type {
  ClaimRequest,
  ClaimResponse,
  EnrollRequest,
  EnrollResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HelloRequest,
  HelloResponse,
  JobCompleteRequest,
  JobCompleteResponse,
  JobProgressRequest,
  JobProgressResponse,
  JobStartRequest,
  JobStartResponse,
  RenewRequest,
  RenewResponse,
} from '@exponetdb/contracts'
import type { JsonValue } from '@exponetdb/kernel'
import type { AgentGateway, Presented } from '@exponetdb/nodes'

export type { Presented } from '@exponetdb/nodes'

/**
 * The agent API use cases ([protocol.md](../../../exponetdb-docs/07-node-agent/protocol.md),
 * [control-plane.md §5](../../../exponetdb-docs/07-node-agent/control-plane.md#5-gateway)).
 * The gateway's listener (`apps/server/src/interfaces/gateway`) owns the
 * transport, the client certificate and the message schemas; every decision
 * is made here and in `packages/nodes`, never in the interface.
 */
export interface AgentApi {
  enroll(request: EnrollRequest): Promise<EnrollResponse>
  hello(presented: Presented, request: HelloRequest): Promise<HelloResponse>
  heartbeat(presented: Presented, request: HeartbeatRequest): Promise<HeartbeatResponse>
  claim(presented: Presented, request: ClaimRequest, signal?: AbortSignal): Promise<ClaimResponse>
  start(presented: Presented, jobId: string, request: JobStartRequest): Promise<JobStartResponse>
  progress(
    presented: Presented,
    jobId: string,
    request: JobProgressRequest,
  ): Promise<JobProgressResponse>
  /** `received` is the completion as the agent sent it (strict JSON), stored as is. */
  complete(
    presented: Presented,
    jobId: string,
    request: JobCompleteRequest,
    received?: JsonValue,
  ): Promise<JobCompleteResponse>
  renew(presented: Presented, request: RenewRequest): Promise<RenewResponse>
}

/** The agent API over the gateway's node service. */
export function agentApi(gateway: AgentGateway): AgentApi {
  return {
    enroll: (request) => gateway.enroll(request),
    hello: (presented, request) => gateway.hello(presented, request),
    heartbeat: (presented, request) => gateway.heartbeat(presented, request),
    claim: (presented, request, signal) => gateway.claim(presented, request, signal),
    start: (presented, jobId, request) => gateway.start(presented, jobId, request),
    progress: (presented, jobId, request) => gateway.progress(presented, jobId, request),
    complete: (presented, jobId, request, received) =>
      gateway.complete(presented, jobId, request, received),
    renew: (presented, request) => gateway.renew(presented, request),
  }
}
