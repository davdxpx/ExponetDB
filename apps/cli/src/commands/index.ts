import type { CommandSpec } from '../cli/spec.ts'
import { accessCommands } from './access.ts'
import { authCommands } from './auth.ts'
import { diagnoseCommands } from './diagnose.ts'
import { generalCommands } from './general.ts'
import { migrationCommands } from './migration.ts'
import { nodeCommands } from './node.ts'
import { planCommands } from './plan.ts'
import { profileCommands } from './profile.ts'
import { registryCommands } from './registry.ts'

/** The command registry: the only list of commands (help, completion and the reference come from it). */
export const COMMANDS: readonly CommandSpec[] = [
  ...generalCommands,
  ...authCommands,
  ...profileCommands,
  ...registryCommands,
  ...nodeCommands,
  ...migrationCommands,
  ...planCommands,
  ...diagnoseCommands,
  ...accessCommands,
]
