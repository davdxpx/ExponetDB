import type { RequestId } from '@exponetdb/kernel'
import type { HttpBindings } from '@hono/node-server'

/** The Hono environment of every HTTP app: the request id and, under Node.js, the raw request. */
export type HttpEnv = { Variables: { requestId: RequestId }; Bindings: Partial<HttpBindings> }
