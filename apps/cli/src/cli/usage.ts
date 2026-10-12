import type { CommandSpec } from './types.ts'

/** A usage error: exit 2, with a close suggestion when there is one. */
export class UsageError extends Error {
  override readonly name = 'UsageError'
  readonly suggestion: string | undefined
  readonly command: CommandSpec | undefined
  constructor(message: string, suggestion?: string, command?: CommandSpec) {
    super(message)
    this.suggestion = suggestion
    this.command = command
  }
}
