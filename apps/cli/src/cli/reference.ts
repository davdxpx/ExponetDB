import { GLOBAL_FLAGS } from './args.ts'
import { commandName, GROUP_TITLES } from './spec.ts'
import type { CommandSpec, FlagSpec, Group } from './types.ts'

/**
 * The command reference and the agent help, generated from the registry
 * ([`15-cli/reference.md`](../../../../exponetdb-docs/15-cli/reference.md)
 * is this text; a test keeps it current). Nothing here is written by hand
 * per command.
 */
function flagCell(f: FlagSpec): string {
  const value =
    f.type === 'boolean'
      ? ''
      : f.type === 'enum'
        ? ` <${(f.values ?? []).join('\\|')}>`
        : ` <${f.placeholder ?? f.type}>`
  return `\`--${f.name}${value}\``
}

function usage(c: CommandSpec): string {
  const args = (c.args ?? [])
    .map((a) =>
      a.required === true
        ? `<${a.name}${a.variadic === true ? '…' : ''}>`
        : `[${a.name}${a.variadic === true ? '…' : ''}]`,
    )
    .join(' ')
  return `exponetdb ${commandName(c)}${args.length === 0 ? '' : ` ${args}`}${(c.flags ?? []).length === 0 ? '' : ' [flags]'}`
}

export function referenceMarkdown(commands: readonly CommandSpec[]): string {
  const lines: string[] = [
    '# `exponetdb` command reference',
    '',
    '<!-- Generated from the command registry (apps/cli/src/commands). Do not edit by hand:',
    '     run `bun run --cwd apps/cli reference` and commit the result. -->',
    '',
    'Every command, generated from the registry: what it does, whether it runs',
    'locally or against the server, what it changes, the action and scopes it',
    'needs, its arguments and flags. Global flags, the output contract and the',
    'exit codes are in [`README.md`](./README.md).',
    '',
  ]
  const groups = new Map<Group, CommandSpec[]>()
  for (const c of commands) groups.set(c.group, [...(groups.get(c.group) ?? []), c])
  const order = Object.keys(GROUP_TITLES) as Group[]
  lines.push('| Command | Runs | Effect | Summary |', '|---|---|---|---|')
  for (const g of order) {
    for (const c of groups.get(g) ?? []) {
      lines.push(
        `| [\`${commandName(c)}\`](#${commandName(c).replaceAll(' ', '-')}) | ${c.locality} | ${c.effect} | ${c.summary.replaceAll('|', '\\|')} |`,
      )
    }
  }
  lines.push('')
  for (const g of order) {
    const list = groups.get(g)
    if (list === undefined) continue
    lines.push(`## ${GROUP_TITLES[g]}`, '')
    for (const c of list) {
      lines.push(`### ${commandName(c)}`, '', c.summary, '')
      if (c.description !== undefined) lines.push(c.description, '')
      lines.push('```text', usage(c), '```', '')
      const facts = [
        `Runs: ${c.locality === 'local' ? 'locally' : 'against the server'}`,
        `effect: ${c.effect}`,
        ...(c.action === undefined ? [] : [`action: \`${c.action}\``]),
        ...(c.scopes === undefined || c.scopes.length === 0
          ? []
          : [`scopes: ${c.scopes.map((s) => `\`${s}\``).join(', ')}`]),
        `output: \`${c.output}\``,
      ]
      lines.push(`${facts.join('; ')}.`, '')
      if ((c.aliases ?? []).length > 0) {
        lines.push(`Aliases: ${(c.aliases ?? []).map((a) => `\`${a.join(' ')}\``).join(', ')}.`, '')
      }
      if ((c.args ?? []).length > 0 || (c.flags ?? []).length > 0) {
        lines.push('| Argument or flag | Meaning |', '|---|---|')
        for (const a of c.args ?? []) {
          lines.push(
            `| \`${a.name}\`${a.required === true ? ' (required)' : ''} | ${a.description.replaceAll('|', '\\|')} |`,
          )
        }
        for (const f of c.flags ?? []) {
          const extra = [
            f.required === true ? 'required' : undefined,
            f.default === undefined ? undefined : `default ${String(f.default)}`,
          ].filter((x): x is string => x !== undefined)
          lines.push(
            `| ${flagCell(f)} | ${f.description.replaceAll('|', '\\|')}${extra.length === 0 ? '' : ` (${extra.join(', ')})`} |`,
          )
        }
        lines.push('')
      }
      if ((c.examples ?? []).length > 0) {
        lines.push('```sh', ...(c.examples ?? []), '```', '')
      }
    }
  }
  lines.push('## Global flags', '', '| Flag | Meaning |', '|---|---|')
  for (const f of GLOBAL_FLAGS)
    lines.push(
      `| ${flagCell(f)}${f.short === undefined ? '' : ` (\`-${f.short}\`)`} | ${f.description} |`,
    )
  lines.push('')
  return lines.join('\n')
}

/** The agent help: how an automated caller uses the CLI safely, then the reference. */
export function agentHelp(commands: readonly CommandSpec[]): string {
  return [
    '# Using `exponetdb` from an automated agent',
    '',
    '- Always pass `--output json` (one document) or `--output ndjson` (item, progress, result or error records); both follow `exponetdb.cli-output/v1` and never carry a token, a banner or a hint.',
    '- Pass `--no-input`: nothing prompts and no browser opens; a missing approval, re-authentication or confirmation ends with its exit code instead.',
    '- Exit codes: 0 contract met (a waiting mutation: applied and verified), 1 failure, 2 usage, 3 sign-in, scope or re-authentication, 4 blocked by policy, approval or evidence (a person must act), 5 server unavailable or incompatible, 6 timed out or outcome needs reconciliation, 130 interrupted.',
    '- Changes are plans: plan (the server analyzes and decides), then `exponetdb plan apply <plan> --wait`. The plan is bound to its target, tier and content; applying never uses current defaults. A failed verification is never a success.',
    '- Production: plans need the evidence of a verified staging apply with the same checksum; agent-initiated production changes need a human approval (the Web App) and fresh re-authentication through the browser. `--yes` skips local confirmations only; it never replaces an approval, a re-authentication or evidence.',
    '- There is no command that runs SQL, a shell or a script remotely, and none that resets production.',
    '',
    referenceMarkdown(commands),
  ].join('\n')
}
