import { countTokens, exceedsParseWork, MAX_PARSE_TOKENS } from '@exponetdb/postgres/parser'
import { RegistryError } from '@exponetdb/registry'

/**
 * The token budget of a whole request (test campaign TC-021, Part A P1 no. 2), counted with the
 * bodies of DO blocks and functions. Each file is bounded by `MAX_PARSE_TOKENS`, which limits one
 * parse; the memory of a chain analysis adds up across files (about 15 KiB retained per file;
 * 565 MiB peak and 226 MiB of the 268 MiB heap limit for nine files of 190,000 tokens, 1.7
 * million in all) and it runs in the worker, so the sum is bounded as well. The campaign
 * proposed 600,000; the 600-file, 3 MB history of the size of the first real import (556 files,
 * 2.7 MB) holds 623,009 such tokens, so the budget is 1,000,000: the real import fits with
 * margin and the dense case is refused.
 */
export const MAX_TOTAL_PARSE_TOKENS = 1_000_000

/**
 * Refuses, before any work on them, legacy files one parse could not be
 * given (`MAX_PARSE_TOKENS`, deployment.md §2a): the file, or a body in it,
 * holds more tokens than the parser's memory budget allows, or the files
 * together hold more than {@link MAX_TOTAL_PARSE_TOKENS}. The bytes are
 * bounded by the contract (`LEGACY_FILES_LIMIT_BYTES`); the tokens decide
 * the memory (follow-up 2, the verification review P1-1).
 */
export function refuseOversizedLegacyFiles(
  files: readonly { readonly name: string; readonly text: string }[],
): void {
  let remaining = MAX_TOTAL_PARSE_TOKENS
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
    // With the bodies of DO blocks and functions, which a replay parses as well.
    remaining -= countTokens(f.text, remaining + 1, 'standard', true)
    if (remaining < 0) {
      throw new RegistryError('VALIDATION_FAILED', {
        errors: [
          {
            path: `/files/${i}/text`,
            code: 'too_large',
            message: `The files together hold more than ${MAX_TOTAL_PARSE_TOKENS} tokens: import the history in several parts.`,
          },
        ],
      })
    }
  }
}
