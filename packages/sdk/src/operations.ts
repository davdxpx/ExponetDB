/**
 * The browser-safe part of the SDK (`@exponetdb/sdk/operations`): the
 * generated operations table and the generated wire types, nothing else.
 * No transport, no credentials, no `node:` module and no `jose`: the Web App
 * types its own cookie-and-CSRF client with it (Wave 8 order D10,
 * [`sdk.md`](../../../exponetdb-docs/13-integrations/sdk.md)). The token
 * transport of the SDK stays Node-only.
 */
export type * from './generated/api.ts'
export { OPERATIONS } from './generated/api.ts'
