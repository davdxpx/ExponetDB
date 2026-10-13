import type { Application } from '@exponetdb/application'
import {
  type ErrorCode,
  isScope,
  MCP_RESOURCE_CACHE,
  MCP_STATIC_RESOURCES,
  resourceRef,
  type Scope,
  targetSummaryUri,
} from '@exponetdb/contracts'
import { describeError, type Logger } from '@exponetdb/observability'
import { existenceFloor } from '../existence.ts'
import { errorCodeOf } from '../http/request.ts'
import type { CursorCodec } from './cursor.ts'
import { grantOf, type McpCallContext } from './registry.ts'
import { escapeValue } from './results.ts'

/**
 * The resources of `/mcp` (Wave 7 order §23, tool-catalog.md §11): the
 * static guides of the contracts for every authenticated client, and one
 * summary per target, read through the same use case as `target_get` (the
 * engine decides). A target the caller may not read is "not found", as in
 * `target_get`; nothing about it is revealed.
 */
export interface ResourceEntry {
  readonly uri: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly mimeType: string
}

export type ResourceRead =
  | {
      readonly kind: 'ok'
      readonly uri: string
      readonly mimeType: string
      readonly text: string
      readonly cache: { readonly ttlMs: number; readonly cacheScope: 'public' | 'private' }
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'refused'; readonly code: ErrorCode }

export interface ResourceHost {
  /** Static resources, then the summaries of the targets the caller can see (one page). */
  list(
    ctx: McpCallContext,
    cursor: string | undefined,
  ): Promise<
    | { readonly kind: 'ok'; readonly resources: ResourceEntry[]; readonly nextCursor?: string }
    | { readonly kind: 'invalid_cursor' }
  >
  read(ctx: McpCallContext, uri: string): Promise<ResourceRead>
}

/** Target summaries per `resources/list` page. */
const TARGET_PAGE = 50
const HIDDEN: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'TARGET_NOT_FOUND',
  'NOT_FOUND',
  'TARGET_NOT_IN_GRANT',
  'TIER_NOT_PERMITTED',
])

/** Refusals that mean "this caller cannot list targets", not a failure. */
const LIST_REFUSALS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PERMISSION_DENIED',
  'INSUFFICIENT_SCOPE',
  'TIER_NOT_PERMITTED',
  'TARGET_NOT_IN_GRANT',
])

function staticEntries(): ResourceEntry[] {
  return MCP_STATIC_RESOURCES.map(({ uri, name, title, description, mimeType }) => ({
    uri,
    name,
    title,
    description,
    mimeType,
  }))
}

export function createResourceHost(
  application: Pick<Application, 'registry'>,
  logger: Logger,
  cursors: CursorCodec,
): ResourceHost {
  /** Maps a refusal of the engine: a missing scope becomes the step-up challenge. */
  const refusal = (ctx: McpCallContext, error: unknown): ErrorCode => {
    const code = errorCodeOf(error)
    if (code === 'INTERNAL') {
      logger.error('mcp.resource_failed', { ...describeError(error) })
    }
    if (code === 'INSUFFICIENT_SCOPE') {
      const details =
        error instanceof Error && 'details' in error
          ? (error as { details?: unknown }).details
          : undefined
      const required =
        typeof details === 'object' && details !== null
          ? (details as Record<string, unknown>)['requiredScope']
          : undefined
      if (typeof required === 'string' && isScope(required)) {
        const scopes = new Set<Scope>(ctx.principal.delegation.scopes).add(required)
        ctx.challenge = { required, scopes: [...scopes].sort() }
      }
    }
    return code
  }

  return {
    async list(ctx, cursor) {
      const binding = { grant: grantOf(ctx.principal), tool: 'resources/list', filters: null }
      const inner = cursor === undefined ? undefined : await cursors.open(binding, cursor)
      if (cursor !== undefined && inner === undefined) {
        return { kind: 'invalid_cursor' }
      }
      const resources = cursor === undefined ? staticEntries() : []
      // Without a target read scope the list is the static resources only (truthful: the
      // grant cannot read targets); any other failure is an error, never a shorter list.
      if (!ctx.principal.delegation.scopes.has('targets.read')) {
        return { kind: 'ok', resources }
      }
      try {
        const page = await application.registry.targets(
          ctx.caller,
          {},
          { limit: TARGET_PAGE, ...(inner === undefined ? {} : { cursor: inner }) },
        )
        for (const target of page.items) {
          resources.push({
            uri: targetSummaryUri(target.id),
            name: `target-${target.id}`,
            title: `Target ${target.id}`,
            description: `Summary of the target ${target.id} (${target.tier}); the same data as target_get.`,
            mimeType: 'application/json',
          })
        }
        return {
          kind: 'ok',
          resources,
          ...(page.nextCursor === null
            ? {}
            : { nextCursor: await cursors.seal(binding, page.nextCursor) }),
        }
      } catch (error) {
        const code = errorCodeOf(error)
        if (code === 'VALIDATION_FAILED') {
          return { kind: 'invalid_cursor' }
        }
        if (LIST_REFUSALS.has(code)) {
          // The engine refuses this caller the target list: the static resources are all it can read.
          return { kind: 'ok', resources }
        }
        throw error
      }
    },

    async read(ctx, uri) {
      // One time class for every "not there", unknown, concealed or real (existence.ts).
      const started = performance.now()
      const notFound = async (): Promise<ResourceRead> => {
        await existenceFloor(started)
        return { kind: 'not_found' }
      }
      const ref = resourceRef(uri)
      if (ref === undefined) {
        return notFound()
      }
      if (ref.kind === 'static') {
        return {
          kind: 'ok',
          uri: ref.resource.uri,
          mimeType: ref.resource.mimeType,
          text: ref.resource.text(),
          cache: MCP_RESOURCE_CACHE.static,
        }
      }
      try {
        const target = await application.registry.target(ctx.caller, ref.targetId)
        return {
          kind: 'ok',
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(escapeValue(target)),
          cache: MCP_RESOURCE_CACHE.target,
        }
      } catch (error) {
        const code = refusal(ctx, error)
        return HIDDEN.has(code) ? notFound() : { kind: 'refused', code }
      }
    },
  }
}
