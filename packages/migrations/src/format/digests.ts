import { encodeUtf8, err, ok, type Result } from '@exponetdb/kernel'
import { sha256Hex, sha256HexOf } from '@exponetdb/kernel/hash'
import {
  type ProjectionRefusal,
  parseMigrationManifest,
  parseProjectDefaults,
  projectManifest,
} from './projection.ts'
import { normalizeSqlSource, type SqlRefusal, scanExecutableText } from './sql.ts'

/**
 * Frames and digests of `c1` (N6). Frozen when the owner accepts G1.
 *
 *   frame(label, b) = UTF8(label) LF decimal(len(b)) LF b LF
 *
 * The apply checksum and the rollback digest frame the executable text X(f)
 * (comments and whitespace runs do not count). The verify digest frames the
 * normalized source S(f) of verify.sql (N1 and N2 only), so every comment,
 * including the `-- check:`, `-- covers:`, `-- calls:` and `-- reads-view:`
 * directives and any directive added later, is bound.
 */
export function frame(label: string, bytes: Uint8Array): Uint8Array[] {
  return [encodeUtf8(`${label}\n${bytes.length}\n`), bytes, encodeUtf8('\n')]
}

/** F(name): the file frame, or the empty frame plus the `:absent` marker frame. */
function fileFrame(name: SqlFileName, content: string | null): Uint8Array[] {
  if (content === null) {
    return [...frame(name, new Uint8Array()), ...frame(`${name}:absent`, new Uint8Array())]
  }
  return frame(name, encodeUtf8(content))
}

export type SqlFileName = 'up.sql' | 'verify.sql' | 'down.sql'

export const APPLY_PREFIX = 'exponetdb/migration-checksum/c1\n'
export const VERIFY_PREFIX = 'exponetdb/verify-digest/c1\n'
export const ROLLBACK_PREFIX = 'exponetdb/rollback-digest/c1\n'
export const BUNDLE_PREFIX = 'exponetdb/bundle-digest/c1\n'

export interface BundleDigests {
  /** Apply checksum `sha256:c1:<hex>`: identity binding of the migration id. */
  readonly checksum: string
  readonly verifyDigest: string
  readonly rollbackDigest: string
  readonly bundleDigest: string
  /** `sha256:<hex>` of up.sql after N1 and N2 (comment edits change it, never the checksum). */
  readonly sourceDigest: string
  /** S(verify.sql): verify.sql after N1 and N2, as framed in the verify digest; null when absent. */
  readonly verifySource: string | null
  readonly projections: {
    readonly apply: string
    readonly verify: string
    readonly rollback: string
  }
  /**
   * Executable texts (N5); null for an absent file. verify.sql is scanned too,
   * so a lexically broken file is refused, but its executable text is not hashed.
   */
  readonly executableText: {
    readonly 'up.sql': string
    readonly 'verify.sql': string | null
    readonly 'down.sql': string | null
  }
  /** The canonical manifest (P) with materialized defaults, recorded with the bundle. */
  readonly canonicalManifest: Readonly<Record<string, unknown>>
}

export type DigestRefusal =
  | ProjectionRefusal
  | { readonly code: SqlRefusal; readonly file: SqlFileName }
  | { readonly code: 'missing_file'; readonly file: 'up.sql' }

export interface DigestInput {
  /** Parsed migration.yaml (validated here against exponetdb.migration/v1). */
  readonly manifest: unknown
  /** The `defaults` block of exponetdb.project.yaml (validated here). */
  readonly projectDefaults: unknown
  /** Exact file bytes; a missing key is an absent file. */
  readonly files: {
    readonly 'up.sql'?: Uint8Array
    readonly 'verify.sql'?: Uint8Array
    readonly 'down.sql'?: Uint8Array
  }
}

function digestOf(prefix: string, chunks: Uint8Array[]): string {
  return `sha256:c1:${sha256HexOf([encodeUtf8(prefix), ...chunks])}`
}

/**
 * Computes every `c1` digest of a bundle. Refusals are reported in the
 * specified order: project defaults, the projections, then up.sql,
 * verify.sql, down.sql. Whether the files agree with the manifest is bundle
 * validation, not this function (see `validateBundle`).
 */
export function computeBundleDigests(input: DigestInput): Result<BundleDigests, DigestRefusal> {
  const defaults = parseProjectDefaults(input.projectDefaults)
  if (!defaults.ok) {
    return defaults
  }
  const manifest = parseMigrationManifest(input.manifest)
  if (!manifest.ok) {
    return manifest
  }
  const projections = projectManifest(manifest.value, defaults.value)
  if (!projections.ok) {
    return projections
  }
  const up = input.files['up.sql']
  if (up === undefined) {
    return err({ code: 'missing_file', file: 'up.sql' })
  }
  const upSource = normalizeSqlSource(up)
  if (!upSource.ok) {
    return err({ code: upSource.error, file: 'up.sql' })
  }
  const upText = scanExecutableText(upSource.value)
  if (!upText.ok) {
    return err({ code: upText.error, file: 'up.sql' })
  }
  const verifySource = optionalSource(input.files['verify.sql'])
  if (!verifySource.ok) {
    return err({ code: verifySource.error, file: 'verify.sql' })
  }
  const verifyText = optionalScan(verifySource.value)
  if (!verifyText.ok) {
    return err({ code: verifyText.error, file: 'verify.sql' })
  }
  const downText = optionalText(input.files['down.sql'])
  if (!downText.ok) {
    return err({ code: downText.error, file: 'down.sql' })
  }
  const p = projections.value
  const checksum = digestOf(APPLY_PREFIX, [
    ...frame('manifest', encodeUtf8(p.apply)),
    ...frame('up.sql', encodeUtf8(upText.value)),
  ])
  const verifyDigest = digestOf(VERIFY_PREFIX, [
    ...frame('manifest', encodeUtf8(p.verify)),
    ...fileFrame('verify.sql', verifySource.value),
  ])
  const rollbackDigest = digestOf(ROLLBACK_PREFIX, [
    ...frame('manifest', encodeUtf8(p.rollback)),
    ...fileFrame('down.sql', downText.value),
  ])
  const bundleDigest = digestOf(BUNDLE_PREFIX, [
    ...frame('checksum', encodeUtf8(checksum)),
    ...frame('verifyDigest', encodeUtf8(verifyDigest)),
    ...frame('rollbackDigest', encodeUtf8(rollbackDigest)),
  ])
  return ok({
    checksum,
    verifyDigest,
    rollbackDigest,
    bundleDigest,
    sourceDigest: `sha256:${sha256Hex(upSource.value)}`,
    verifySource: verifySource.value,
    projections: { apply: p.apply, verify: p.verify, rollback: p.rollback },
    executableText: {
      'up.sql': upText.value,
      'verify.sql': verifyText.value,
      'down.sql': downText.value,
    },
    canonicalManifest: p.applyFields,
  })
}

/** S(f): N1 and N2 of an optional file; null when absent. */
function optionalSource(bytes: Uint8Array | undefined): Result<string | null, SqlRefusal> {
  return bytes === undefined ? ok(null) : normalizeSqlSource(bytes)
}

/** X(f) from S(f) (N4, N5); null when absent. */
function optionalScan(source: string | null): Result<string | null, SqlRefusal> {
  return source === null ? ok(null) : scanExecutableText(source)
}

function optionalText(bytes: Uint8Array | undefined): Result<string | null, SqlRefusal> {
  const source = optionalSource(bytes)
  return source.ok ? optionalScan(source.value) : source
}
