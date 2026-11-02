import { err, ok, type Result } from '@exponetdb/kernel'
import { isAlias, isNode, Lexer, parseAllDocuments, visit } from 'yaml'

export interface YamlIssue {
  readonly path: string
  readonly code:
    | 'yaml_syntax'
    | 'yaml_multiple_documents'
    | 'yaml_alias'
    | 'yaml_anchor'
    | 'yaml_tag'
    | 'yaml_empty'
    | 'yaml_depth'
  readonly message: string
}

/**
 * Parses migration.yaml or exponetdb.project.yaml strictly: one YAML 1.2
 * document, core schema (`yes` is a string, not a boolean), unique keys, no
 * anchors or aliases, no tags, no merge keys. The result is plain data for
 * schema validation; nothing in the file can create objects or references.
 */
export const MAX_YAML_FLOW_DEPTH = 32

/** The deepest nesting of flow collections (`[` and `{`), read by the library's non-recursive lexer. */
function flowDepth(text: string): number {
  let depth = 0
  let deepest = 0
  for (const token of new Lexer().lex(text)) {
    if (token === '[' || token === '{') {
      depth++
      if (depth > deepest) deepest = depth
      if (deepest > MAX_YAML_FLOW_DEPTH) break
    } else if (token === ']' || token === '}') {
      depth = Math.max(0, depth - 1)
    }
  }
  return deepest
}

export function parseStrictYaml(text: string): Result<unknown, YamlIssue> {
  // The library composes flow collections by recursion: a few thousand brackets overflow its stack
  // (VC-094). The depth is bounded before the document is composed, with a named reason.
  if (flowDepth(text) > MAX_YAML_FLOW_DEPTH) {
    return err({
      path: '',
      code: 'yaml_depth',
      message: `Flow collections nest at most ${MAX_YAML_FLOW_DEPTH} levels.`,
    })
  }
  const documents = parseAllDocuments(text, {
    version: '1.2',
    schema: 'core',
    uniqueKeys: true,
    merge: false,
    prettyErrors: false,
    strict: true,
  })
  if (!Array.isArray(documents)) {
    return err({ path: '', code: 'yaml_empty', message: 'The file has no YAML document.' })
  }
  if (documents.length !== 1) {
    return err({
      path: '',
      code: documents.length === 0 ? 'yaml_empty' : 'yaml_multiple_documents',
      message: 'The file must contain exactly one YAML document.',
    })
  }
  const [document] = documents
  if (document === undefined) {
    return err({ path: '', code: 'yaml_empty', message: 'The file has no YAML document.' })
  }
  const problem = document.errors[0] ?? document.warnings[0]
  if (problem !== undefined) {
    return err({
      path: '',
      code: 'yaml_syntax',
      message: problem.message.split('\n')[0] ?? 'Invalid YAML.',
    })
  }
  let refusal: YamlIssue | undefined
  visit(document, (_key, node) => {
    if (isAlias(node)) {
      refusal = { path: '', code: 'yaml_alias', message: 'Aliases are not allowed.' }
      return visit.BREAK
    }
    if (isNode(node) && node.anchor !== undefined) {
      refusal = { path: '', code: 'yaml_anchor', message: 'Anchors are not allowed.' }
      return visit.BREAK
    }
    if (isNode(node) && node.tag !== undefined) {
      refusal = { path: '', code: 'yaml_tag', message: 'Explicit tags are not allowed.' }
      return visit.BREAK
    }
    return undefined
  })
  if (refusal !== undefined) {
    return err(refusal)
  }
  return ok(document.toJS({ maxAliasCount: 0 }))
}
