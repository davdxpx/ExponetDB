/**
 * Deterministic JSON for generated artifacts: object members sorted by name
 * (UTF-16 order), two-space indentation, LF, trailing newline. No timestamps,
 * paths or tool versions ever enter an artifact. The functions live in
 * `@exponetdb/contracts` (the OpenAPI builder that `serve` also runs uses
 * them); the generators import them from here.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export {
  hoistDefinitions,
  isPlainObject as isObject,
  renameKeyword,
  stableStringify,
} from '@exponetdb/contracts'
