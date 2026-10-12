import { prepareLint } from '@exponetdb/migrations/lint'
import { CliError } from '../errors.ts'

export type Major = 16 | 17 | 18

export const MAJORS: readonly Major[] = [16, 17, 18]

/**
 * Loads PostgreSQL's parser of one major (libpg-query, WASM, shipped with the
 * CLI). A missing or damaged asset is one clear error naming the major, not
 * the parser runtime's own messages: those are held back while it loads (the
 * CLI itself never writes through `console`).
 */
export async function loadGrammar(major: Major): Promise<void> {
  const original = console.error
  console.error = () => undefined
  try {
    await prepareLint(major)
  } catch {
    throw new CliError(
      'parser_unavailable',
      `The PostgreSQL ${major} parser of this installation cannot be loaded; reinstall the CLI (exponetdb doctor lists the parsers).`,
    )
  } finally {
    console.error = original
  }
}
