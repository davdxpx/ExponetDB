import { GLOBAL_FLAGS } from './args.ts'
import { type CommandSpec, commandName, type FlagSpec, GROUP_TITLES, type Group } from './spec.ts'

/**
 * Help text generated from the registry: the root help groups every command,
 * a group help lists its commands, a command help shows its arguments,
 * flags with defaults, scopes, locality and examples. Nothing here is
 * written by hand per command, so help and dispatch cannot disagree.
 */
function flagLine(f: FlagSpec): string {
  const name = `${f.short === undefined ? '    ' : `-${f.short}, `}--${f.name}`
  const value =
    f.type === 'boolean'
      ? ''
      : f.type === 'enum'
        ? ` <${(f.values ?? []).join('|')}>`
        : ` <${f.placeholder ?? f.type}>`
  const extra = [
    f.required === true ? 'required' : undefined,
    f.default !== undefined ? `default ${String(f.default)}` : undefined,
  ].filter((x): x is string => x !== undefined)
  return `  ${(name + value).padEnd(34)} ${f.description}${extra.length === 0 ? '' : ` (${extra.join(', ')})`}`
}

export function rootHelp(commands: readonly CommandSpec[]): string {
  const lines = [
    'exponetdb: the ExponetDB command-line client',
    '',
    'Usage: exponetdb <command> [arguments] [flags]',
    '',
  ]
  const groups = new Map<Group, CommandSpec[]>()
  for (const c of commands) groups.set(c.group, [...(groups.get(c.group) ?? []), c])
  for (const [group, list] of [...groups.entries()].sort(
    (a, b) => Object.keys(GROUP_TITLES).indexOf(a[0]) - Object.keys(GROUP_TITLES).indexOf(b[0]),
  )) {
    lines.push(`${GROUP_TITLES[group]}:`)
    for (const c of list) lines.push(`  ${commandName(c).padEnd(30)} ${c.summary}`)
    lines.push('')
  }
  lines.push('Global flags:')
  for (const f of GLOBAL_FLAGS) lines.push(flagLine(f))
  lines.push(
    '',
    'Run `exponetdb <command> --help` for a command, `exponetdb commands` for the full list.',
    'Exit codes: 0 ok, 1 failure, 2 usage, 3 sign-in or scope, 4 blocked by policy or approval,',
    '5 server unavailable, 6 outcome unresolved or timeout, 130 interrupted.',
  )
  return lines.join('\n')
}

export function groupHelp(
  commands: readonly CommandSpec[],
  words: readonly string[],
): string | undefined {
  const list = commands.filter((c) => words.every((w, i) => c.path[i] === w))
  if (list.length === 0) return undefined
  const lines = [`Usage: exponetdb ${words.join(' ')} <command> [flags]`, '', 'Commands:']
  for (const c of list) lines.push(`  ${commandName(c).padEnd(30)} ${c.summary}`)
  lines.push('', 'Run `exponetdb <command> --help` for one of them.')
  return lines.join('\n')
}

export function commandHelp(c: CommandSpec): string {
  const args = (c.args ?? [])
    .map((a) =>
      a.required === true
        ? `<${a.name}${a.variadic === true ? '…' : ''}>`
        : `[${a.name}${a.variadic === true ? '…' : ''}]`,
    )
    .join(' ')
  const lines = [
    `${commandName(c)}: ${c.summary}`,
    '',
    `Usage: exponetdb ${commandName(c)}${args.length === 0 ? '' : ` ${args}`}${(c.flags ?? []).length === 0 ? '' : ' [flags]'}`,
  ]
  if (c.description !== undefined) lines.push('', c.description)
  if ((c.aliases ?? []).length > 0) {
    lines.push('', `Aliases: ${(c.aliases ?? []).map((a) => a.join(' ')).join(', ')}`)
  }
  if ((c.args ?? []).length > 0) {
    lines.push('', 'Arguments:')
    for (const a of c.args ?? []) {
      lines.push(
        `  ${a.name.padEnd(32)} ${a.description}${a.required === true ? ' (required)' : ''}`,
      )
    }
  }
  if ((c.flags ?? []).length > 0) {
    lines.push('', 'Flags:')
    for (const f of c.flags ?? []) lines.push(flagLine(f))
  }
  const facts = [
    `Runs: ${c.locality === 'local' ? 'locally (no server)' : 'against the server'}`,
    `Effect: ${c.effect}`,
    ...(c.action === undefined ? [] : [`Action: ${c.action}`]),
    ...(c.scopes === undefined || c.scopes.length === 0 ? [] : [`Scopes: ${c.scopes.join(', ')}`]),
    `Output: --output table|json|ndjson (data: ${c.output})`,
  ]
  lines.push('', ...facts)
  if ((c.examples ?? []).length > 0) {
    lines.push('', 'Examples:')
    for (const e of c.examples ?? []) lines.push(`  ${e}`)
  }
  lines.push('', 'Global flags: see `exponetdb --help`.')
  return lines.join('\n')
}
