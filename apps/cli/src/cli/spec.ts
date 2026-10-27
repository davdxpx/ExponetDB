import type { CommandSpec, Group } from './types.ts'

/**
 * A command of the registry ([`15-cli/README.md` §1](../../../../exponetdb-docs/15-cli/README.md#1-architecture)).
 * Help, completion, the reference and the agent help are generated from
 * these declarations; a command that is declared dispatches. The types
 * live in `types.ts`.
 */
export type { ArgSpec, CommandInput, CommandSpec, FlagSpec, FlagType, Group } from './types.ts'

export const GROUP_TITLES: Record<Group, string> = {
  general: 'General',
  auth: 'Sign-in',
  config: 'Profiles and configuration',
  project: 'Project (local)',
  registry: 'Registry',
  node: 'Nodes',
  migration: 'Migrations',
  plan: 'Plans',
  operation: 'Operations',
  approval: 'Approvals',
  diagnose: 'Diagnostics',
  backup: 'Backups and restores',
  access: 'Access and audit',
  dev: 'Local test lab',
  secrets: 'Local secret utilities',
}

export function commandName(spec: Pick<CommandSpec, 'path'>): string {
  return spec.path.join(' ')
}
