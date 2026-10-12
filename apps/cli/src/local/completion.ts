import { GLOBAL_FLAGS } from '../cli/args.ts'
import type { CommandSpec } from '../cli/spec.ts'
import { BUILD } from '../version.ts'

/**
 * Shell completion generated from the registry ([`15-cli/README.md`](../../../../exponetdb-docs/15-cli/README.md)):
 * command words and flags of this CLI version, completed without any
 * network request or token refresh. Every word written into a script is a
 * plain identifier (checked here), so a script never interpolates data.
 */
const WORD = /^[a-z][a-z0-9-]*$/

function checked(word: string): string {
  if (!WORD.test(word)) throw new Error(`not a completable word: ${word}`)
  return word
}

interface Tree {
  /** Command path (space separated) → next words. */
  readonly children: Map<string, Set<string>>
  /** Command path → its flags (long names). */
  readonly flags: Map<string, string[]>
}

function tree(commands: readonly CommandSpec[]): Tree {
  const children = new Map<string, Set<string>>()
  const flags = new Map<string, string[]>()
  for (const c of commands) {
    for (const path of [c.path, ...(c.aliases ?? [])]) {
      for (let i = 0; i < path.length; i++) {
        const prefix = path.slice(0, i).map(checked).join(' ')
        const set = children.get(prefix) ?? new Set<string>()
        set.add(checked(path[i] ?? ''))
        children.set(prefix, set)
      }
      flags.set(
        path.map(checked).join(' '),
        (c.flags ?? []).map((f) => `--${checked(f.name)}`),
      )
    }
  }
  return { children, flags }
}

const globals = () => GLOBAL_FLAGS.map((f) => `--${checked(f.name)}`).join(' ')

function bash(t: Tree): string {
  const cases: string[] = []
  for (const [path, words] of [...t.children.entries()].sort()) {
    cases.push(`    "${path}") candidates="${[...words].sort().join(' ')}" ;;`)
  }
  for (const [path, list] of [...t.flags.entries()].sort()) {
    if (t.children.has(path)) continue
    cases.push(`    "${path}") candidates="${list.join(' ')}" ;;`)
  }
  return `# exponetdb completion for bash (exponetdb ${BUILD.version}); no network on Tab.
_exponetdb() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" path="" i candidates=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in -*) ;; *) path="\${path:+$path }\${COMP_WORDS[i]}" ;; esac
  done
  case "$path" in
${cases.join('\n')}
    *) candidates="" ;;
  esac
  if [[ "$cur" == -* ]]; then candidates="$candidates ${globals()}"; fi
  COMPREPLY=($(compgen -W "$candidates" -- "$cur"))
}
complete -F _exponetdb exponetdb
`
}

function zsh(t: Tree): string {
  return `#compdef exponetdb
# exponetdb completion for zsh (exponetdb ${BUILD.version}), through bash completion.
autoload -U +X bashcompinit && bashcompinit
${bash(t)}`
}

function fish(t: Tree): string {
  const lines = [
    `# exponetdb completion for fish (exponetdb ${BUILD.version}); no network on Tab.`,
    'function __exponetdb_path',
    '  set -l words (commandline -opc)',
    '  set -l path',
    '  for w in $words[2..-1]',
    "    if not string match -q -- '-*' $w",
    '      set path $path $w',
    '    end',
    '  end',
    '  string join " " $path',
    'end',
    'complete -c exponetdb -f',
  ]
  for (const [path, words] of [...t.children.entries()].sort()) {
    lines.push(
      `complete -c exponetdb -n 'test "(__exponetdb_path)" = "${path}"' -a '${[...words].sort().join(' ')}'`,
    )
  }
  for (const [path, list] of [...t.flags.entries()].sort()) {
    for (const flag of list) {
      lines.push(
        `complete -c exponetdb -n 'test "(__exponetdb_path)" = "${path}"' -l ${flag.slice(2)}`,
      )
    }
  }
  for (const f of GLOBAL_FLAGS) lines.push(`complete -c exponetdb -l ${checked(f.name)}`)
  return `${lines.join('\n')}\n`
}

export function completionScript(
  shell: 'bash' | 'zsh' | 'fish',
  commands: readonly CommandSpec[],
): string {
  const t = tree(commands)
  return shell === 'bash' ? bash(t) : shell === 'zsh' ? zsh(t) : fish(t)
}
