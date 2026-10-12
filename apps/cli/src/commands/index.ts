import type { CommandSpec } from '../cli/spec.ts'
import { authCommands } from './auth.ts'
import { generalCommands } from './general.ts'
import { profileCommands } from './profile.ts'

/** The command registry: the only list of commands (help, completion and the reference come from it). */
export const COMMANDS: readonly CommandSpec[] = [
  ...generalCommands,
  ...authCommands,
  ...profileCommands,
]
