import type { OperationId, Operations } from '@exponetdb/sdk'
import { countLine, header } from '../output/format.ts'
import { type Block, type Column, type CommandResult, result } from '../output/model.ts'
import { collect, LIST_FLAGS, type ListId, listingFailure } from './lists.ts'
import { must } from './remote.ts'
import type { CommandInput, CommandSpec, FlagSpec, Remote } from './types.ts'

/**
 * Read commands over one REST route: a list (paged, every item, partial
 * listings reported) or one resource (a detail view). The view never
 * invents a value: an absent field reads as `unknown` or `-`, and the JSON
 * output carries the server's answer as it was validated.
 */
interface ReadBase extends Omit<CommandSpec, 'run' | 'locality' | 'effect'> {
  readonly title: string
}

export interface ListSpec<Id extends ListId> extends ReadBase {
  readonly operation: Id
  readonly noun: string
  /** Path parameters; may resolve a reference (a slug) through the server. */
  readonly params?: (
    input: CommandInput,
    remote: Remote,
  ) => Operations[Id]['params'] | Promise<Operations[Id]['params']>
  readonly query?: (input: CommandInput) => Record<string, unknown>
  readonly columns: readonly Column[]
  readonly row: (
    item: Operations[Id]['response']['items'][number],
    now: number,
  ) => readonly string[]
  readonly empty?: string
}

export function listCommand<Id extends ListId>(spec: ListSpec<Id>): CommandSpec {
  const { operation, noun, params, query, columns, row, empty, title, ...rest } = spec
  return {
    ...rest,
    flags: [...(rest.flags ?? []), ...LIST_FLAGS],
    locality: 'remote',
    effect: 'read',
    async run(ctx, input): Promise<CommandResult> {
      const remote = await ctx.remote()
      const listing = await collect(
        remote,
        operation,
        await params?.(input, remote),
        (query?.(input) ?? {}) as never,
        input.flags,
      )
      const now = ctx.io.now()
      const name = rest.path.join(' ')
      const blocks: Block[] = [
        header(title, remote.context),
        {
          kind: 'table',
          columns,
          rows: listing.items.map((i) => row(i, now)),
          empty: empty ?? `No ${noun}s you may read.`,
        },
        countLine(listing.items.length, noun, listing.partial),
      ]
      return (
        listingFailure(name, listing, { blocks }) ??
        result({
          command: name,
          items: listing.items,
          blocks,
          next:
            listing.nextCursor === null ? [] : [`exponetdb ${name} --cursor ${listing.nextCursor}`],
        })
      )
    },
  }
}

type ShowId = {
  [K in OperationId]: Operations[K]['body'] extends Record<string, never> ? K : never
}[OperationId]

export interface ShowSpec<Id extends ShowId> extends ReadBase {
  readonly operation: Id
  readonly params: (
    input: CommandInput,
    remote: Remote,
  ) => Operations[Id]['params'] | Promise<Operations[Id]['params']>
  readonly query?: (input: CommandInput) => Record<string, unknown>
  readonly view: (value: Operations[Id]['response'], now: number) => readonly Block[]
  readonly next?: (value: Operations[Id]['response']) => readonly string[]
}

export function showCommand<Id extends ShowId>(spec: ShowSpec<Id>): CommandSpec {
  const { operation, params, query, view, next, title, ...rest } = spec
  return {
    ...rest,
    locality: 'remote',
    effect: 'read',
    async run(ctx, input): Promise<CommandResult> {
      const remote = await ctx.remote()
      const value = must(
        await remote.sdk.call(operation, {
          params: await params(input, remote),
          ...(query === undefined ? {} : { query: query(input) }),
        } as never),
      ) as Operations[Id]['response']
      return result({
        command: rest.path.join(' '),
        data: value,
        blocks: [header(title, remote.context), ...view(value, ctx.io.now())],
        next: next?.(value) ?? [],
      })
    },
  }
}

/** A required positional argument as a string. */
export const arg = (input: CommandInput, name: string): string => String(input.args[name] ?? '')

/** An optional string flag. */
export const flag = (input: CommandInput, name: string): string | undefined =>
  typeof input.flags[name] === 'string' ? (input.flags[name] as string) : undefined

export const TARGET_FLAG: FlagSpec = {
  name: 'target',
  type: 'string',
  placeholder: 'target',
  description: 'A target id (tgt_…) or path (product/project/environment).',
}
