/**
 * The central list of keyboard shortcuts of the Web App (design-system.md
 * section 3, "Command patterns"). Every shortcut has an id, one binding and the
 * words the help dialog shows. Components refer to a shortcut by id only; the
 * keys live here, so a conflict can be found in one place.
 *
 * Rules the definitions must keep (`defineShortcuts` checks them and throws):
 * - a sequence is two letters and starts with `g` (go to) or `e` (environment);
 * - the only single-key shortcut is `?`;
 * - a chord is the platform modifier (Command on Apple platforms, Control
 *   elsewhere) plus one letter, or plus Enter (`enter`, the run key of the SQL
 *   editor);
 * - no two shortcuts share a binding.
 */

/** Platform modifier plus one letter (`Mod+K`) or plus Enter (`key: 'enter'`). */
export interface ChordBinding {
  readonly type: 'chord'
  readonly key: string
}

/** Two letters pressed one after the other, for example `G` then `P`. */
export interface SequenceBinding {
  readonly type: 'sequence'
  readonly keys: readonly [string, string]
}

/** A single key without modifiers. Only `?` is allowed. */
export interface KeyBinding {
  readonly type: 'key'
  readonly key: string
}

export type ShortcutBinding = ChordBinding | SequenceBinding | KeyBinding

export const SHORTCUT_GROUPS = ['General', 'Go to', 'Switch environment', 'SQL editor'] as const
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number]

export interface ShortcutDefinition {
  readonly binding: ShortcutBinding
  /** What the shortcut does, as a command: "Go to plans". */
  readonly label: string
  readonly group: ShortcutGroup
}

/** The letters a sequence may start with. */
export const SEQUENCE_LEADERS = ['g', 'e'] as const

export const SHORTCUT_DEFINITIONS = {
  'palette.open': {
    binding: { type: 'chord', key: 'k' },
    label: 'Open the command menu',
    group: 'General',
  },
  'help.open': {
    binding: { type: 'key', key: '?' },
    label: 'Show keyboard shortcuts',
    group: 'General',
  },
  'nav.overview': {
    binding: { type: 'sequence', keys: ['g', 'h'] },
    label: 'Go to overview',
    group: 'Go to',
  },
  'nav.projects': {
    binding: { type: 'sequence', keys: ['g', 'r'] },
    label: 'Go to projects',
    group: 'Go to',
  },
  'nav.targets': {
    binding: { type: 'sequence', keys: ['g', 't'] },
    label: 'Go to databases',
    group: 'Go to',
  },
  'nav.changes': {
    binding: { type: 'sequence', keys: ['g', 'c'] },
    label: 'Go to changes',
    group: 'Go to',
  },
  'nav.plans': {
    binding: { type: 'sequence', keys: ['g', 'p'] },
    label: 'Go to plans',
    group: 'Go to',
  },
  'nav.operations': {
    binding: { type: 'sequence', keys: ['g', 'o'] },
    label: 'Go to operations',
    group: 'Go to',
  },
  'nav.infrastructure': {
    binding: { type: 'sequence', keys: ['g', 'i'] },
    label: 'Go to infrastructure',
    group: 'Go to',
  },
  'nav.backups': {
    binding: { type: 'sequence', keys: ['g', 'b'] },
    label: 'Go to backups',
    group: 'Go to',
  },
  'nav.access': {
    binding: { type: 'sequence', keys: ['g', 'a'] },
    label: 'Go to access',
    group: 'Go to',
  },
  'nav.audit': {
    binding: { type: 'sequence', keys: ['g', 'u'] },
    label: 'Go to audit',
    group: 'Go to',
  },
  'nav.settings': {
    binding: { type: 'sequence', keys: ['g', 's'] },
    label: 'Go to settings',
    group: 'Go to',
  },
  'env.production': {
    binding: { type: 'sequence', keys: ['e', 'p'] },
    label: 'Switch to production',
    group: 'Switch environment',
  },
  'env.staging': {
    binding: { type: 'sequence', keys: ['e', 's'] },
    label: 'Switch to staging',
    group: 'Switch environment',
  },
  'env.development': {
    binding: { type: 'sequence', keys: ['e', 'd'] },
    label: 'Switch to development',
    group: 'Switch environment',
  },
  'sql.run': {
    binding: { type: 'chord', key: 'enter' },
    label: 'Run the query',
    group: 'SQL editor',
  },
  'sql.save': {
    binding: { type: 'chord', key: 's' },
    label: 'Save the query',
    group: 'SQL editor',
  },
} as const satisfies Record<string, ShortcutDefinition>

export type ShortcutId = keyof typeof SHORTCUT_DEFINITIONS
