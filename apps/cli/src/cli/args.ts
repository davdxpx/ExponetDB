import type { CommandInput, CommandSpec, FlagSpec, GlobalOptions } from './types.ts'
import { UsageError } from './usage.ts'

export type { GlobalOptions }

/**
 * The argument parser ([`15-cli/README.md` §2](../../../../exponetdb-docs/15-cli/README.md#2-global-flags)).
 * Deterministic: global flags anywhere, `--flag value` and `--flag=value`,
 * `--` ends flags, a negative number is a value where a number is expected.
 * An unknown command or flag, a missing value, a bad value and a repeated
 * flag with another value are usage errors with a close suggestion; nothing
 * is ignored silently.
 */
export { UsageError }

export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'help', short: 'h', type: 'boolean', description: 'Show help for the command.' },
  { name: 'version', type: 'boolean', description: 'Show the CLI version and build (no network).' },
  {
    name: 'server',
    type: 'string',
    placeholder: 'url',
    description: 'Server origin (https; http only on a loopback host).',
  },
  { name: 'profile', type: 'string', placeholder: 'name', description: 'Use a named profile.' },
  {
    name: 'workdir',
    type: 'string',
    placeholder: 'dir',
    description: 'Directory to search the project file from (default: the current one).',
  },
  {
    name: 'output',
    short: 'o',
    type: 'enum',
    values: ['table', 'json', 'ndjson'],
    description: 'Output format.',
  },
  { name: 'json', type: 'boolean', description: 'Same as --output json.' },
  {
    name: 'color',
    type: 'enum',
    values: ['auto', 'always', 'never'],
    description: 'Color (auto follows the terminal, NO_COLOR and TERM).',
  },
  { name: 'no-color', type: 'boolean', description: 'Same as --color never.' },
  {
    name: 'no-input',
    type: 'boolean',
    description: 'Never prompt and never open a browser; end with the exit code instead.',
  },
  {
    name: 'yes',
    type: 'boolean',
    description:
      'Skip local, non-security confirmations (never a permission, approval, re-authentication or evidence).',
  },
  { name: 'quiet', short: 'q', type: 'boolean', description: 'Results only, no hints.' },
  { name: 'verbose', short: 'v', type: 'boolean', description: 'Safe diagnostics on stderr.' },
  {
    name: 'timeout',
    type: 'duration',
    placeholder: 'duration',
    description: 'Per-request deadline, e.g. 30s or 2m (default 30s).',
  },
]

export interface Parsed {
  readonly global: GlobalOptions
  /** Undefined when only global flags (or nothing) were given. */
  readonly command: CommandSpec | undefined
  /** The words that named a command group without a command (for its help). */
  readonly words: readonly string[]
  readonly input: CommandInput
}

/** Edit distance with adjacent transpositions (optimal string alignment), for suggestions. */
export function distance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  const at = (i: number, j: number) => rows[i]?.[j] ?? 0
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, at(i - 2, j - 2) + 1)
      const row = rows[i]
      if (row !== undefined) row[j] = d
    }
  }
  return at(a.length, b.length)
}

function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let score = Number.POSITIVE_INFINITY
  for (const c of candidates) {
    const s = distance(word, c)
    if (s < score) {
      best = c
      score = s
    }
  }
  return best !== undefined && score <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined
}

const DURATION = /^(\d{1,6})(ms|s|m|h)?$/

/** A duration in milliseconds: `250ms`, `30s` (default unit), `2m`, `1h`. */
export function parseDuration(value: string): number | undefined {
  const m = DURATION.exec(value)
  if (m === null) return undefined
  const n = Number(m[1])
  const unit = m[2] ?? 's'
  return unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
}

function convert(flag: FlagSpec, raw: string): string | number | boolean | readonly string[] {
  switch (flag.type) {
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new UsageError(`--${flag.name} needs a number.`)
      return Number(raw)
    }
    case 'duration': {
      const ms = parseDuration(raw)
      if (ms === undefined) {
        throw new UsageError(`--${flag.name} needs a duration such as 30s, 2m or 500ms.`)
      }
      return ms
    }
    case 'enum': {
      if (!(flag.values ?? []).includes(raw)) {
        const s = closest(raw, flag.values ?? [])
        throw new UsageError(
          `--${flag.name} is one of ${(flag.values ?? []).join(', ')}.`,
          s === undefined ? undefined : `--${flag.name} ${s}`,
        )
      }
      return raw
    }
    case 'list':
      return raw
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
    default:
      return raw
  }
}

interface Resolution {
  readonly spec: CommandSpec | undefined
  readonly consumed: number
  readonly words: readonly string[]
}

/** The longest command path (or alias) the leading words name. */
function resolve(commands: readonly CommandSpec[], words: readonly string[]): Resolution {
  let best: Resolution = { spec: undefined, consumed: 0, words: [] }
  for (const spec of commands) {
    for (const path of [spec.path, ...(spec.aliases ?? [])]) {
      if (path.length > words.length || path.length <= best.consumed) continue
      if (path.every((p, i) => words[i] === p)) best = { spec, consumed: path.length, words: path }
    }
  }
  return best
}

/** Whether the leading words name a group of commands (e.g. `migration`). */
function groupPrefix(commands: readonly CommandSpec[], words: readonly string[]): number {
  let n = 0
  for (const spec of commands) {
    for (const path of [spec.path, ...(spec.aliases ?? [])]) {
      let k = 0
      while (k < path.length - 1 && k < words.length && path[k] === words[k]) k++
      if (k > n) n = k
    }
  }
  return n
}

export function parse(commands: readonly CommandSpec[], argv: readonly string[]): Parsed {
  const globalByName = new Map(GLOBAL_FLAGS.map((f) => [f.name, f]))
  const globalByShort = new Map(
    GLOBAL_FLAGS.filter((f) => f.short !== undefined).map((f) => [f.short as string, f]),
  )
  const globals = new Map<string, string | number | boolean | readonly string[]>()
  const isFlag = (a: string) => a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)
  // First pass: the leading words name the command; global flags may stand among them,
  // the first other flag (a command flag) or `--` ends them.
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--') break
    if (isFlag(a)) {
      const g = a.startsWith('--')
        ? globalByName.get(a.slice(2).split('=')[0] ?? '')
        : globalByShort.get(a.slice(1))
      if (g === undefined) break
      if (g.type !== 'boolean' && !a.includes('=')) i++
      continue
    }
    words.push(a)
  }
  const resolution = resolve(commands, words)
  const spec = resolution.spec
  if (spec === undefined && words.length > 0) {
    const n = groupPrefix(commands, words)
    if (n < words.length || n === 0) {
      const names = [
        ...new Set(commands.flatMap((c) => [c.path, ...(c.aliases ?? [])].map((p) => p.join(' ')))),
      ]
      const attempt = words.slice(0, Math.min(words.length, 3)).join(' ')
      const s = closest(attempt, names) ?? closest(words.slice(0, 2).join(' '), names)
      throw new UsageError(
        `Unknown command: ${words.join(' ')}`,
        s === undefined ? undefined : `exponetdb ${s}`,
      )
    }
  }
  const positional: string[] = []
  let skipWords = spec === undefined ? words.length : resolution.consumed
  const commandFlags = new Map((spec?.flags ?? []).map((f) => [f.name, f]))
  const commandShort = new Map(
    (spec?.flags ?? []).filter((f) => f.short !== undefined).map((f) => [f.short as string, f]),
  )
  const flags = new Map<string, string | number | boolean | readonly string[]>()
  const set = (
    target: Map<string, string | number | boolean | readonly string[]>,
    flag: FlagSpec,
    value: string | number | boolean | readonly string[],
  ) => {
    const before = target.get(flag.name)
    if (before !== undefined && JSON.stringify(before) !== JSON.stringify(value)) {
      throw new UsageError(`--${flag.name} is given twice with different values.`, undefined, spec)
    }
    target.set(flag.name, value)
  }
  // Second pass over every token: flags, and positionals after the command words.
  let afterDashes = false
  const tokens = argv
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i] ?? ''
    if (afterDashes || !isFlag(a)) {
      if (!afterDashes && skipWords > 0) {
        skipWords--
        continue
      }
      positional.push(a)
      continue
    }
    if (a === '--') {
      afterDashes = true
      continue
    }
    let name: string
    let inline: string | undefined
    let flag: FlagSpec | undefined
    let isGlobal = false
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      name = eq === -1 ? a.slice(2) : a.slice(2, eq)
      inline = eq === -1 ? undefined : a.slice(eq + 1)
      flag = commandFlags.get(name)
      if (flag === undefined) {
        flag = globalByName.get(name)
        isGlobal = flag !== undefined
      }
    } else {
      name = a.slice(1)
      flag = commandShort.get(name)
      if (flag === undefined) {
        flag = globalByShort.get(name)
        isGlobal = flag !== undefined
      }
    }
    if (flag === undefined) {
      const known = [...commandFlags.keys(), ...globalByName.keys()]
      const s = closest(name, known)
      throw new UsageError(`Unknown flag: ${a}`, s === undefined ? undefined : `--${s}`, spec)
    }
    let value: string | number | boolean | readonly string[]
    if (flag.type === 'boolean') {
      if (inline !== undefined) {
        if (inline !== 'true' && inline !== 'false') {
          throw new UsageError(`--${flag.name} takes no value (or true/false).`, undefined, spec)
        }
        value = inline === 'true'
      } else {
        value = true
      }
    } else {
      const raw = inline ?? tokens[i + 1]
      if (inline === undefined) i++
      if (raw === undefined || (raw.startsWith('-') && !/^-\d/.test(raw) && raw !== '-')) {
        throw new UsageError(`--${flag.name} needs a value.`, undefined, spec)
      }
      try {
        value = convert(flag, raw)
      } catch (error) {
        if (error instanceof UsageError) throw new UsageError(error.message, error.suggestion, spec)
        throw error
      }
    }
    set(isGlobal ? globals : flags, flag, value)
  }
  // Positional arguments of the command.
  const args: Record<string, string | readonly string[] | undefined> = {}
  const specs = spec?.args ?? []
  let k = 0
  for (const arg of specs) {
    if (arg.variadic === true) {
      args[arg.name] = positional.slice(k)
      k = positional.length
    } else {
      args[arg.name] = positional[k]
      if (positional[k] !== undefined) k++
    }
  }
  const help = globals.get('help') === true
  if (spec !== undefined && !help) {
    if (k < positional.length) {
      throw new UsageError(`Unexpected argument: ${positional[k]}`, undefined, spec)
    }
    for (const arg of specs) {
      const v = args[arg.name]
      if (arg.required === true && (v === undefined || (Array.isArray(v) && v.length === 0))) {
        throw new UsageError(`Missing argument <${arg.name}>.`, undefined, spec)
      }
      // An empty argument (an unset shell variable) is never an id or a name.
      if (v === '' || (Array.isArray(v) && v.includes(''))) {
        throw new UsageError(`Argument <${arg.name}> is empty.`, undefined, spec)
      }
    }
    for (const flag of spec.flags ?? []) {
      if (flag.required === true && !flags.has(flag.name)) {
        throw new UsageError(`Missing flag --${flag.name}.`, undefined, spec)
      }
      if (!flags.has(flag.name) && flag.default !== undefined) flags.set(flag.name, flag.default)
    }
  }
  const output =
    globals.get('json') === true
      ? 'json'
      : (globals.get('output') as GlobalOptions['output'] | undefined)
  if (globals.get('json') === true && globals.has('output') && globals.get('output') !== 'json') {
    throw new UsageError('--json and --output disagree.')
  }
  const color =
    globals.get('no-color') === true ? 'never' : (globals.get('color') as GlobalOptions['color'])
  const global: GlobalOptions = {
    help,
    version: globals.get('version') === true,
    noInput: globals.get('no-input') === true,
    yes: globals.get('yes') === true,
    quiet: globals.get('quiet') === true,
    verbose: globals.get('verbose') === true,
    ...(globals.has('server') ? { server: String(globals.get('server')) } : {}),
    ...(globals.has('profile') ? { profile: String(globals.get('profile')) } : {}),
    ...(globals.has('workdir') ? { workdir: String(globals.get('workdir')) } : {}),
    ...(output === undefined ? {} : { output }),
    ...(color === undefined ? {} : { color }),
    ...(globals.has('timeout') ? { timeoutMs: Number(globals.get('timeout')) } : {}),
  }
  return {
    global,
    command: spec,
    words: spec === undefined ? words : resolution.words,
    input: { args, flags: Object.fromEntries(flags) },
  }
}
