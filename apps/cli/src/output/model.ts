/**
 * The typed result of a command ([`15-cli/README.md` §4](../../../../exponetdb-docs/15-cli/README.md#4-output-contract-exponetdbcli-outputv1)).
 * One result feeds every format: JSON prints `data` and the envelope, NDJSON
 * prints `items` then the envelope, the human renderer prints `blocks`. A
 * format never decides anything differently.
 */
export const OUTPUT_SCHEMA = 'exponetdb.cli-output/v1'

export type Status = 'ok' | 'accepted' | 'requires_action' | 'failed' | 'error'

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted'

export interface SafeError {
  readonly code: string
  readonly message: string
  readonly remediation?: string
  /** Structured details of the catalog entry (rendered as data, never as markup). */
  readonly details?: unknown
}

export interface Column {
  readonly title: string
  /** May be shortened (with a visible mark) when the terminal is narrow. */
  readonly flexible?: boolean
  readonly align?: 'left' | 'right'
}

export type Block =
  | {
      readonly kind: 'header'
      readonly title: string
      readonly context?: readonly (readonly [string, string])[]
    }
  | { readonly kind: 'fields'; readonly rows: readonly (readonly [string, string | null])[] }
  | {
      readonly kind: 'table'
      readonly columns: readonly Column[]
      readonly rows: readonly (readonly string[])[]
      readonly empty?: string
    }
  | { readonly kind: 'text'; readonly lines: readonly string[]; readonly tone?: Tone }
  | { readonly kind: 'status'; readonly word: string; readonly tone: Tone; readonly text?: string }

export interface CommandResult {
  readonly command: string
  readonly status: Status
  readonly exitCode: number
  readonly data?: unknown
  /** List results: one NDJSON `item` record each (and `data.items` in JSON). */
  readonly items?: readonly unknown[]
  /** A paged listing stopped part-way: the items are not the complete list. */
  readonly partial?: boolean
  readonly requestId?: string
  readonly planId?: string
  readonly operationId?: string
  readonly error?: SafeError
  readonly next?: readonly string[]
  readonly blocks: readonly Block[]
}

/** The safe context printed with a remote result (never a token or a credential). */
export interface OutputContext {
  readonly server?: string
  readonly profile?: string
  readonly installationId?: string
}

export function result(
  partial: Omit<CommandResult, 'blocks' | 'status' | 'exitCode'> &
    Partial<Pick<CommandResult, 'blocks' | 'status' | 'exitCode'>>,
): CommandResult {
  return { status: 'ok', exitCode: 0, blocks: [], ...partial }
}
