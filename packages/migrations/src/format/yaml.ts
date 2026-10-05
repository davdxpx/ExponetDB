import { err, ok, type Result } from '@exponetdb/kernel'
import { isAlias, isNode, parseAllDocuments, visit } from 'yaml'

export interface YamlIssue {
  readonly path: string
  readonly code:
    | 'yaml_syntax'
    | 'yaml_multiple_documents'
    | 'yaml_alias'
    | 'yaml_anchor'
    | 'yaml_tag'
    | 'yaml_empty'
  readonly message: string
}

/**
 * Parses migration.yaml or exponetdb.project.yaml strictly: one YAML 1.2
 * document, core schema (`yes` is a string, not a boolean), unique keys, no
 * anchors or aliases, no tags, no merge keys. The result is plain data for
 * schema validation; nothing in the file can create objects or references.
 */
export function parseStrictYaml(text: string): Result<unknown, YamlIssue> {
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
