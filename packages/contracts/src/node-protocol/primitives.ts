import * as z from 'zod'

/** Leaf schemas shared by the node protocol messages and the capability catalog. */

export const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/)

export const SystemIdentifierSchema = z
  .string()
  .regex(/^[0-9]{1,20}$/)
  .meta({ description: 'PostgreSQL system_identifier (uint64 as decimal text).' })

export const LocalClusterNameSchema = z
  .string()
  .regex(/^[0-9]{2}\/[a-z0-9_-]{1,63}$/)
  .meta({ description: 'PostgreSQL major/cluster name, e.g. 17/main.' })

/** An absolute path reported by the host (never chosen by the Control Plane). */
export const HostPathSchema = z
  .string()
  .max(4096)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern excludes NUL on purpose
  .regex(/^\/[^\x00]*$/)

export const Base64UrlSchema = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`))
    .meta({ description: `${bytes} bytes, base64url without padding.` })

/** A raw 32-byte Ed25519 or X25519 public key (protocol.md §7.1). */
export const PublicKeySchema = Base64UrlSchema(32)

/** An Ed25519 signature (protocol.md §7.1). */
export const SignatureSchema = Base64UrlSchema(64)

export const KeyIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
