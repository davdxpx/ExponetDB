import { exceedsParseWork, MAX_PARSE_TOKENS } from '@exponetdb/postgres/parser'
import { RegistryError } from '@exponetdb/registry'

/**
 * Refuses, before any work on them, legacy files one parse could not be
 * given (`MAX_PARSE_TOKENS`, deployment.md §2a): the file, or a body in it,
 * holds more tokens than the parser's memory budget allows. The bytes are
 * bounded by the contract (`LEGACY_FILES_LIMIT_BYTES`); the tokens decide
 * the memory (follow-up 2, the verification review P1-1).
 */
export function refuseOversizedLegacyFiles(
  files: readonly { readonly name: string; readonly text: string }[],
): void {
  for (const [i, f] of files.entries()) {
    if (exceedsParseWork(f.text)) {
      throw new RegistryError('VALIDATION_FAILED', {
        errors: [
          {
            path: `/files/${i}/text`,
            code: 'too_large',
            message: `The file, or a body in it, holds more than ${MAX_PARSE_TOKENS} tokens: split it into several files.`,
          },
        ],
      })
    }
  }
}
