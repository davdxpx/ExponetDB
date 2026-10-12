import { EXIT } from '../cli/exit.ts'
import { commandHelp, groupHelp, rootHelp } from '../cli/help.ts'
import { type CommandSpec, commandName } from '../cli/spec.ts'
import { completionScript } from '../local/completion.ts'
import { result } from '../output/model.ts'
import { BUILD } from '../version.ts'

/** `help`, `version`, `commands`, `completion`. */
export const generalCommands: readonly CommandSpec[] = [
  {
    path: ['help'],
    summary: 'Show help for a command or group.',
    group: 'general',
    args: [
      { name: 'command', description: 'A command or group, e.g. migration plan.', variadic: true },
    ],
    locality: 'local',
    effect: 'local',
    output: 'Help',
    examples: ['exponetdb help', 'exponetdb help migration plan'],
    async run(ctx, input) {
      const words = (input.args['command'] as readonly string[] | undefined) ?? []
      const exact = ctx.commands.find((c) => commandName(c) === words.join(' '))
      const text =
        words.length === 0
          ? rootHelp(ctx.commands)
          : exact !== undefined
            ? commandHelp(exact)
            : groupHelp(ctx.commands, words)
      if (text === undefined) {
        return result({
          command: 'help',
          status: 'error',
          exitCode: EXIT.usage,
          error: { code: 'usage', message: `No command or group named ${words.join(' ')}.` },
          next: ['exponetdb commands'],
        })
      }
      return result({
        command: 'help',
        data: { text },
        blocks: [{ kind: 'text', lines: text.split('\n') }],
      })
    },
  },
  {
    path: ['version'],
    summary: 'Show the CLI version and build (no network).',
    group: 'general',
    locality: 'local',
    effect: 'local',
    output: 'Version',
    async run() {
      const data = {
        version: BUILD.version,
        commit: BUILD.commit,
        builtAt: BUILD.builtAt,
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
        outputSchema: 'exponetdb.cli-output/v1',
      }
      return result({
        command: 'version',
        data,
        blocks: [
          {
            kind: 'fields',
            rows: [
              ['Version', data.version],
              ['Build', data.commit],
              ['Built', data.builtAt],
              ['Node', data.node],
              ['Platform', data.platform],
              ['Output', data.outputSchema],
            ],
          },
        ],
      })
    },
  },
  {
    path: ['commands'],
    summary: 'List every command with its group, locality and effect.',
    group: 'general',
    locality: 'local',
    effect: 'local',
    output: 'CommandList',
    async run(ctx) {
      const items = ctx.commands.map((c) => ({
        command: commandName(c),
        group: c.group,
        summary: c.summary,
        locality: c.locality,
        effect: c.effect,
        ...(c.action === undefined ? {} : { action: c.action }),
        ...(c.scopes === undefined ? {} : { scopes: [...c.scopes] }),
        aliases: (c.aliases ?? []).map((a) => a.join(' ')),
      }))
      return result({
        command: 'commands',
        items,
        blocks: [
          {
            kind: 'table',
            columns: [
              { title: 'COMMAND' },
              { title: 'RUNS' },
              { title: 'EFFECT' },
              { title: 'SUMMARY', flexible: true },
            ],
            rows: items.map((i) => [i.command, i.locality, i.effect, i.summary]),
          },
        ],
      })
    },
  },
  {
    path: ['completion'],
    summary: 'Print a shell completion script (bash, zsh or fish).',
    description:
      'The script completes command names and flags from this CLI version only: no network, no token refresh on Tab.',
    group: 'general',
    args: [{ name: 'shell', description: 'bash, zsh or fish.', required: true }],
    locality: 'local',
    effect: 'local',
    output: 'Completion',
    examples: [
      'exponetdb completion bash > ~/.local/share/bash-completion/completions/exponetdb',
      'exponetdb completion fish > ~/.config/fish/completions/exponetdb.fish',
    ],
    async run(ctx, input) {
      const shell = String(input.args['shell'])
      if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
        return result({
          command: 'completion',
          status: 'error',
          exitCode: EXIT.usage,
          error: { code: 'usage', message: 'The shell is bash, zsh or fish.' },
        })
      }
      const script = completionScript(shell, ctx.commands)
      if (ctx.format === 'table') {
        // The script itself, unchanged (it is this CLI's own text, never remote data).
        ctx.io.stdout(script)
        return result({ command: 'completion', blocks: [] })
      }
      return result({ command: 'completion', data: { shell, script }, blocks: [] })
    },
  },
]
