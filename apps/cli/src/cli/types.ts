import type { ExponetDB } from '@exponetdb/sdk'
import type { CommandResult, OutputContext } from '../output/model.ts'
import type { Terminal } from '../output/render.ts'
import type { TokenStore } from '../store.ts'
import type { Profile, ProfileStore } from './profiles.ts'

/**
 * The types the CLI's modules share (one module, so the parser, the
 * dispatcher, the remote seam and the commands never import each other in
 * a circle).
 */
export type FlagType = 'boolean' | 'string' | 'number' | 'duration' | 'enum' | 'list'

export interface FlagSpec {
  readonly name: string
  readonly short?: string
  readonly type: FlagType
  readonly description: string
  /** Allowed values of an `enum` flag. */
  readonly values?: readonly string[]
  readonly placeholder?: string
  readonly required?: boolean
  readonly default?: string | number | boolean
}

export interface ArgSpec {
  readonly name: string
  readonly description: string
  readonly required?: boolean
  /** Takes every remaining positional argument. */
  readonly variadic?: boolean
  /**
   * Feeds only the request body of a plan command: required unless `--file`
   * gives the whole body, and refused next to `--file`.
   */
  readonly body?: boolean
}

export type Group =
  | 'general'
  | 'auth'
  | 'config'
  | 'project'
  | 'registry'
  | 'node'
  | 'migration'
  | 'plan'
  | 'operation'
  | 'approval'
  | 'diagnose'
  | 'access'
  | 'dev'
  | 'secrets'

export interface CommandSpec {
  /** The canonical name path, e.g. `['migration', 'plan']`. */
  readonly path: readonly string[]
  /** Other name paths that dispatch to the same command (documented). */
  readonly aliases?: readonly (readonly string[])[]
  readonly summary: string
  readonly description?: string
  readonly group: Group
  readonly args?: readonly ArgSpec[]
  readonly flags?: readonly FlagSpec[]
  readonly examples?: readonly string[]
  /** Whether it talks to a server. */
  readonly locality: 'local' | 'remote'
  /** What it does there. */
  readonly effect: 'read' | 'plan' | 'mutation' | 'local' | 'session'
  /** The contract action it calls (remote commands). */
  readonly action?: string
  /** OAuth scopes it needs (remote commands). */
  readonly scopes?: readonly string[]
  /** The name of its `data` shape in the output contract. */
  readonly output: string
  /** Platforms it runs on (default all). */
  readonly platforms?: readonly ('linux' | 'darwin' | 'win32')[]
  run(ctx: RunContext, input: CommandInput): Promise<CommandResult>
}

export interface CommandInput {
  readonly args: Readonly<Record<string, string | readonly string[] | undefined>>
  readonly flags: Readonly<
    Record<string, string | number | boolean | readonly string[] | undefined>
  >
}

export interface GlobalOptions {
  readonly help: boolean
  readonly version: boolean
  readonly server?: string
  readonly profile?: string
  readonly workdir?: string
  readonly output?: 'table' | 'json' | 'ndjson'
  readonly color?: 'auto' | 'always' | 'never'
  readonly noInput: boolean
  readonly yes: boolean
  readonly quiet: boolean
  readonly verbose: boolean
  readonly timeoutMs?: number
}

/** What the process gives the CLI (tests replace every member). */
export interface Io {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** All of stdin (bounded); empty when it is a terminal. */
  readonly readStdin: (maxBytes: number) => Promise<string>
  readonly tty: { readonly stdout: boolean; readonly stderr: boolean; readonly stdin: boolean }
  readonly columns: number | undefined
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly fetch: typeof fetch
  readonly configDir: string
  readonly platform: NodeJS.Platform
  readonly openBrowser: (url: string) => void
  /** A line typed on the terminal without echo (never logged). */
  readonly readSecret: (prompt: string) => Promise<string>
  readonly confirm: (question: string) => Promise<boolean>
  /** Aborted when the person presses Ctrl-C. */
  readonly signal: AbortSignal
  readonly now: () => number
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface RunContext {
  readonly io: Io
  readonly global: GlobalOptions
  readonly terminal: Terminal
  readonly format: 'table' | 'json' | 'ndjson'
  readonly tokens: TokenStore
  readonly profiles: ProfileStore
  readonly commands: readonly CommandSpec[]
  readonly command: string
  /** The server, profile, installation and an authenticated client (resolved once, when needed). */
  remote(): Promise<Remote>
  /** The safe context of the output (filled once remote() resolved). */
  outputContext(): OutputContext
  /** A progress line: stderr for a person, an NDJSON progress record, nothing for JSON. */
  progress(line: string, data?: unknown): void
  /** A hint for a person on stderr (never in JSON or NDJSON, never with --quiet). */
  hint(line: string): void
}

export interface Remote {
  readonly server: string
  readonly profile: Profile | undefined
  readonly installationId: string | undefined
  /** The installation's answer, read (authenticated) when connecting. */
  readonly installation: { readonly version: string; readonly features: readonly string[] }
  readonly sdk: ExponetDB
  readonly context: OutputContext
}
