import * as z from 'zod'
import { Sha256DigestSchema, TimestampSchema, untrustedText } from '../common.ts'
import {
  Base64UrlSchema,
  HostPathSchema,
  KeyIdSchema,
  LocalClusterNameSchema,
  PublicKeySchema,
  SemverSchema,
  SystemIdentifierSchema,
} from './primitives.ts'

/**
 * The capability catalog of Wave 5 ([capabilities.md](../../../../exponetdb-docs/07-node-agent/capabilities.md),
 * scope in the G5 record §2). Every capability has closed argument and result
 * schemas: the agent refuses a job whose `args` do not match exactly
 * (`args_invalid`, protocol.md §4.2 step 6), and the worker refuses a result
 * that does not match. No argument is a command, a script, SQL text or a path
 * chosen by the Control Plane; every value is typed. Names and values that
 * come from PostgreSQL or the host are untrusted text (C-26).
 *
 * Capabilities outside Wave 5 (backups and restore, `packages.apply_update`,
 * `postgres.databases.apply`) are not in this catalog; the agent answers
 * `capability_unsupported` for them.
 */

// ----- shared parts -----

/**
 * The local PostgreSQL instance a job acts on. The agent maps `localName` to
 * its instance and refuses the job unless the instance's system identifier
 * equals `systemIdentifier` (`precondition_failed`, protocol.md §4.2 step 7).
 */
export const ClusterRefSchema = z
  .strictObject({ localName: LocalClusterNameSchema, systemIdentifier: SystemIdentifierSchema })
  .meta({ id: 'NodeClusterRef' })

/** A value sealed to the node (`ns1`, protocol.md §7.6); never plaintext. */
export const SealedValueSchema = z
  .strictObject({
    ns1: z.strictObject({
      enc: Base64UrlSchema(32),
      ct: z
        .string()
        .min(22)
        .max(4096)
        .regex(/^[A-Za-z0-9_-]+$/)
        .meta({ description: 'Ciphertext and 16-byte tag, base64url.' }),
    }),
  })
  .meta({ id: 'NodeSealedValue', description: 'HPKE ns1 to the node encryption key.' })

/** A PostgreSQL identifier ExponetDB manages: lowercase ASCII, at most 63 bytes. */
const ManagedNameSchema = z.string().regex(/^[a-z_][a-z0-9_$-]{0,62}$/)
/** A configuration parameter name (`name` or `extension.name`). */
const ParameterNameSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$/)

/**
 * Parameters ExponetDB never writes, in a fragment or as a role setting
 * (Phase 4 review): file directives, parameters that run programs, load code
 * or name paths, connection strings, and the socket and port the operator's
 * instance mapping depends on. Writing them would let a signed job run
 * commands or move files on the node. The Go agent applies the same rule;
 * both are checked against `tooling/fixtures/node-parameters/denied.json`.
 */
export const DENIED_PARAMETERS = {
  names: [
    'include',
    'include_dir',
    'include_if_exists',
    'data_directory',
    'config_file',
    'hba_file',
    'ident_file',
    'external_pid_file',
    'event_source',
    'log_filename',
    'port',
    'allow_system_table_mods',
    'session_replication_role',
  ],
  prefixes: ['unix_socket_', 'plperl.', 'pltcl.', 'pltclu.', 'plpython'],
  suffixes: [
    '_command',
    '_file',
    '_files',
    '_directory',
    '_directories',
    '_dir',
    '_library',
    '_libraries',
    '_path',
    '_conninfo',
    '_keyfile',
    '_provider',
  ],
  except: ['search_path'],
} as const

/** Whether ExponetDB may write the parameter (see {@link DENIED_PARAMETERS}). */
export function isManagedParameterName(name: string): boolean {
  const d = DENIED_PARAMETERS
  if ((d.except as readonly string[]).includes(name)) {
    return true
  }
  return !(
    (d.names as readonly string[]).includes(name) ||
    d.prefixes.some((p) => name.startsWith(p)) ||
    d.suffixes.some((x) => name.endsWith(x))
  )
}

/** A parameter name ExponetDB writes: the pattern and {@link isManagedParameterName}. */
const ManagedParameterNameSchema = ParameterNameSchema.refine(isManagedParameterName, {
  message: 'a parameter ExponetDB never writes (a directive, command, library, path or socket)',
})
/** A configuration value: one line, no control characters (it is written into a file). */
const ParameterValueSchema = z
  .string()
  .max(1024)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
  .regex(/^[^\x00-\x1f\x7f]*$/)
const ExtensionNameSchema = z.string().regex(/^[a-z_][a-z0-9_-]{0,62}$/)
const ExtensionVersionSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/)
const LsnSchema = z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/)
/** A lowercase DNS name; patterns here stay within RE2, which the Go agent uses. */
export const DnsNameSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/)
const NameText = untrustedText(256, 'A name read from PostgreSQL or the host.')
const ValueText = untrustedText(4096, 'A value read from PostgreSQL or the host.')
const CountSchema = z.int().min(0)
const BytesSchema = z.int().min(0)
const PercentSchema = z.number().min(0).max(100)

const FileErrorSchema = z
  .strictObject({
    sourcefile: untrustedText(4096, 'Configuration file.').nullable(),
    sourceline: z.int().min(0).nullable(),
    error: untrustedText(1024, 'The error PostgreSQL reports for the line.'),
  })
  .meta({ id: 'NodeConfigFileError' })

const MountSchema = z
  .strictObject({
    path: HostPathSchema,
    usedBytes: BytesSchema,
    totalBytes: BytesSchema,
    inodesUsedPercent: PercentSchema,
  })
  .meta({ id: 'NodeMount' })

const NoArgsSchema = (id: string) => z.strictObject({}).meta({ id })

// ----- PostgreSQL service -----

const PostgresStatusArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapPostgresStatusArgs',
})
const PostgresStatusResult = z
  .strictObject({
    running: z.boolean(),
    acceptingConnections: z.boolean(),
    version: untrustedText(64, 'server_version').nullable(),
    postmasterStartTime: TimestampSchema.nullable(),
    inRecovery: z.boolean().nullable(),
    dataDirectory: HostPathSchema,
  })
  .meta({ id: 'NodeCapPostgresStatusResult' })

const PostgresReloadArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapPostgresReloadArgs',
})
const PostgresReloadResult = z
  .strictObject({
    reloadedAt: TimestampSchema,
    pendingRestart: z.array(ParameterNameSchema).max(512),
    fileErrors: z.array(FileErrorSchema).max(64),
  })
  .meta({ id: 'NodeCapPostgresReloadResult' })

const PostgresRestartPlanArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapPostgresRestartPlanArgs',
})
const PostgresRestartPlanResult = z
  .strictObject({
    shutdownMode: z.literal('fast'),
    pendingRestart: z.array(ParameterNameSchema).max(512),
    connections: z
      .array(
        z.strictObject({
          role: NameText.nullable(),
          application: NameText.nullable(),
          count: CountSchema,
        }),
      )
      .max(256),
    activeBackups: CountSchema,
    activeMaintenance: CountSchema,
    replicationSlots: z.array(z.strictObject({ name: NameText, active: z.boolean() })).max(64),
  })
  .meta({ id: 'NodeCapPostgresRestartPlanResult' })

const PostgresRestartArgs = z
  .strictObject({ cluster: ClusterRefSchema, shutdownMode: z.literal('fast') })
  .meta({ id: 'NodeCapPostgresRestartArgs' })
const PostgresRestartResult = z
  .strictObject({
    postmasterStartTimeBefore: TimestampSchema,
    postmasterStartTimeAfter: TimestampSchema,
    acceptingConnections: z.boolean(),
    version: untrustedText(64, 'server_version'),
    pendingRestart: z.array(ParameterNameSchema).max(512),
  })
  .meta({ id: 'NodeCapPostgresRestartResult' })

// ----- configuration (OD-20: an ExponetDB-managed include fragment) -----

const ManagedIncludeSchema = z
  .strictObject({
    path: HostPathSchema,
    present: z.boolean().meta({ description: 'The fragment file exists.' }),
    included: z
      .boolean()
      .meta({ description: 'postgresql.conf includes the fragment (OD-20 bootstrap need).' }),
    digest: Sha256DigestSchema.nullable().meta({ description: 'sha256 of the fragment file.' }),
  })
  .meta({ id: 'NodeManagedInclude' })

const ConfigInspectArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapConfigInspectArgs',
})
const ConfigInspectResult = z
  .strictObject({
    configVersion: Sha256DigestSchema.meta({
      description:
        'sha256 over the inspected pg_settings and pg_file_settings rows; plans bind it.',
    }),
    settings: z
      .array(
        z.strictObject({
          name: NameText,
          setting: ValueText.nullable(),
          unit: untrustedText(16, 'pg_settings.unit').nullable(),
          source: untrustedText(64, 'pg_settings.source'),
          sourcefile: untrustedText(4096, 'pg_settings.sourcefile').nullable(),
          sourceline: z.int().min(0).nullable(),
          context: untrustedText(32, 'pg_settings.context'),
          vartype: untrustedText(16, 'pg_settings.vartype'),
          pendingRestart: z.boolean(),
        }),
      )
      .max(2048),
    fileSettings: z
      .array(
        z.strictObject({
          sourcefile: untrustedText(4096, 'pg_file_settings.sourcefile').nullable(),
          sourceline: z.int().min(0).nullable(),
          seqno: z.int().min(0).nullable(),
          name: NameText.nullable(),
          setting: ValueText.nullable(),
          applied: z.boolean(),
          error: untrustedText(1024, 'pg_file_settings.error').nullable(),
        }),
      )
      .max(4096),
    managedInclude: ManagedIncludeSchema,
  })
  .meta({ id: 'NodeCapConfigInspectResult' })

/** One planned parameter change of the managed fragment. */
export const ConfigChangeSchema = z.strictObject({
  name: ManagedParameterNameSchema,
  value: ParameterValueSchema.nullable().meta({
    description: 'null removes the parameter from the managed fragment.',
  }),
})

const ConfigPlanArgs = z
  .strictObject({
    cluster: ClusterRefSchema,
    changes: z.array(ConfigChangeSchema).min(1).max(128),
  })
  .meta({ id: 'NodeCapConfigPlanArgs' })
const ConfigPlanResult = z
  .strictObject({
    configVersion: Sha256DigestSchema,
    managedInclude: ManagedIncludeSchema,
    parameters: z
      .array(
        z.strictObject({
          name: ParameterNameSchema,
          valid: z.boolean(),
          invalidReason: z
            .enum(['unknown_parameter', 'invalid_value', 'out_of_range', 'not_settable_in_file'])
            .nullable(),
          current: ValueText.nullable(),
          currentSource: untrustedText(64, 'pg_settings.source').nullable(),
          currentSourcefile: untrustedText(4096, 'pg_settings.sourcefile').nullable(),
          context: untrustedText(32, 'pg_settings.context').nullable(),
          effect: z.enum(['none', 'reload', 'restart']),
          conflict: z.enum(['auto_conf_overrides', 'later_file_overrides']).nullable().meta({
            description:
              'A value read after the managed fragment would win over it: postgresql.auto.conf or a later file.',
          }),
        }),
      )
      .max(128),
  })
  .meta({ id: 'NodeCapConfigPlanResult' })

const ConfigApplyArgs = z
  .strictObject({
    cluster: ClusterRefSchema,
    parameters: z
      .array(z.strictObject({ name: ManagedParameterNameSchema, value: ParameterValueSchema }))
      .max(256)
      .meta({ description: 'The complete content of the managed fragment, in order.' }),
    expectedFragmentDigest: Sha256DigestSchema.nullable().meta({
      description:
        'The fragment the plan saw; null when there was none. Otherwise precondition_failed.',
    }),
    configVersion: Sha256DigestSchema,
    reload: z.boolean(),
  })
  .meta({ id: 'NodeCapConfigApplyArgs' })
const ConfigApplyResult = z
  .strictObject({
    fragmentDigest: Sha256DigestSchema,
    previousFragmentDigest: Sha256DigestSchema.nullable(),
    reloaded: z.boolean(),
    pendingRestart: z.array(ParameterNameSchema).max(512),
    fileErrors: z.array(FileErrorSchema).max(64),
  })
  .meta({ id: 'NodeCapConfigApplyResult' })

// ----- pg_hba -----

const HbaInspectArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapHbaInspectArgs',
})
const HbaInspectResult = z
  .strictObject({
    hbaFile: HostPathSchema,
    fileDigest: Sha256DigestSchema,
    managedBlock: z.strictObject({
      present: z.boolean(),
      digest: Sha256DigestSchema.nullable(),
      lineCount: CountSchema,
    }),
    rules: z
      .array(
        z.strictObject({
          lineNumber: z.int().min(1).nullable(),
          type: untrustedText(16, 'pg_hba_file_rules.type').nullable(),
          database: z.array(NameText).max(64),
          userName: z.array(NameText).max(64),
          address: untrustedText(256, 'pg_hba_file_rules.address').nullable(),
          netmask: untrustedText(64, 'pg_hba_file_rules.netmask').nullable(),
          authMethod: untrustedText(32, 'pg_hba_file_rules.auth_method').nullable(),
          options: z.array(untrustedText(512, 'An option of the rule.')).max(16),
          managed: z.boolean().meta({ description: 'Inside the ExponetDB-managed block.' }),
          error: untrustedText(1024, 'pg_hba_file_rules.error').nullable(),
        }),
      )
      .max(1024),
  })
  .meta({ id: 'NodeCapHbaInspectResult' })

const AddressSchema = z
  .string()
  .regex(
    /^(all|samehost|samenet|([0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}|[0-9a-f:]{2,39}\/[0-9]{1,3})$/,
  )
  .meta({ description: 'A CIDR address, all, samehost or samenet.' })

export const ProtectedAccessSchema = z
  .strictObject({
    role: ManagedNameSchema,
    database: ManagedNameSchema,
    address: z
      .string()
      .regex(/^(local|([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-f:]{2,39})$/)
      .meta({ description: 'A single client address, or local for the Unix socket.' }),
    method: z.enum(['scram-sha-256', 'peer']),
  })
  .meta({ id: 'NodeHbaProtectedAccess' })

/** One rule of the ExponetDB-managed pg_hba block. */
export const HbaRuleSchema = z
  .strictObject({
    type: z.enum(['local', 'hostssl']),
    database: z
      .array(ManagedNameSchema)
      .min(1)
      .max(16)
      .meta({ description: 'Names; all is the pg_hba keyword.' }),
    user: z
      .array(ManagedNameSchema)
      .min(1)
      .max(16)
      .meta({ description: 'Names; all is the pg_hba keyword.' }),
    address: AddressSchema.nullable().meta({ description: 'null for local rules.' }),
    method: z.enum(['scram-sha-256', 'peer', 'reject']),
    map: ManagedNameSchema.nullable().meta({ description: 'peer only: the ident map.' }),
  })
  .superRefine((rule, ctx) => {
    if ((rule.type === 'local') !== (rule.address === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'local rules have no address; hostssl rules need one',
      })
    }
    if (rule.map !== null && rule.method !== 'peer') {
      ctx.addIssue({ code: 'custom', message: 'only peer rules take a map' })
    }
    if (rule.method === 'peer' && rule.type !== 'local') {
      ctx.addIssue({ code: 'custom', message: 'peer is for local rules only' })
    }
  })

const HbaApplyArgs = z
  .strictObject({
    cluster: ClusterRefSchema,
    managedRules: z
      .array(HbaRuleSchema)
      .max(64)
      .meta({ description: 'The complete content of the managed block, in order.' }),
    expectedFileDigest: Sha256DigestSchema,
    protectedAccess: z.array(ProtectedAccessSchema).min(1).max(16).meta({
      description:
        "ExponetDB's own access: each must still match an accepting rule with this method before the reload, else the old file is restored and the job fails.",
    }),
  })
  .meta({ id: 'NodeCapHbaApplyArgs' })
const HbaApplyResult = z
  .strictObject({
    fileDigest: Sha256DigestSchema,
    previousFileDigest: Sha256DigestSchema,
    reloaded: z.boolean(),
    ruleErrors: z.array(FileErrorSchema).max(64),
    protectedAccess: z
      .array(
        z.strictObject({
          access: ProtectedAccessSchema,
          matchedLine: z.int().min(1),
        }),
      )
      .max(16),
  })
  .meta({ id: 'NodeCapHbaApplyResult' })

// ----- TLS (OD-17: the key is generated on the host; the worker holds the CA) -----

const CertificateSummarySchema = z
  .strictObject({
    fingerprint: Sha256DigestSchema.meta({ description: 'sha256 of the DER certificate.' }),
    subject: untrustedText(1024, 'Subject distinguished name.'),
    issuer: untrustedText(1024, 'Issuer distinguished name.'),
    dnsNames: z.array(untrustedText(253, 'A DNS name SAN.')).max(32),
    ipAddresses: z.array(untrustedText(45, 'An IP address SAN.')).max(32),
    notBefore: TimestampSchema,
    notAfter: TimestampSchema,
    keyType: untrustedText(32, 'Key algorithm and size.'),
  })
  .meta({ id: 'NodeCertificateSummary' })

const TlsInspectArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapTlsInspectArgs',
})
const TlsInspectResult = z
  .strictObject({
    ssl: z.boolean(),
    minProtocolVersion: untrustedText(16, 'ssl_min_protocol_version').nullable(),
    certificate: CertificateSummarySchema.nullable(),
  })
  .meta({ id: 'NodeCapTlsInspectResult' })

const StagingIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

const TlsPlanArgs = z
  .strictObject({
    cluster: ClusterRefSchema,
    dnsNames: z.array(DnsNameSchema).max(8),
    ipAddresses: z
      .array(z.string().regex(/^(([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-f:]{2,39})$/))
      .max(8),
  })
  .meta({ id: 'NodeCapTlsPlanArgs' })
const TlsPlanResult = z
  .strictObject({
    stagingId: StagingIdSchema.meta({ description: 'Names the staged key on the host.' }),
    publicKey: Base64UrlSchema(65).meta({
      description: 'P-256 public key, uncompressed point (65 bytes), base64url.',
    }),
    proof: Base64UrlSchema(64).meta({
      description:
        'ECDSA P-256 SHA-256 (r || s) over JCS({purpose: "exponetdb/pgtls-pop/v1", jobId, publicKey}).',
    }),
  })
  .meta({ id: 'NodeCapTlsPlanResult' })

const TlsRotateArgs = z
  .strictObject({
    cluster: ClusterRefSchema,
    stagingId: StagingIdSchema,
    publicKey: Base64UrlSchema(65),
    certificateChain: z
      .array(
        z
          .string()
          .min(1)
          .max(8192)
          .regex(/^[A-Za-z0-9_-]+$/),
      )
      .min(1)
      .max(3)
      .meta({ description: 'DER certificates, base64url: the server certificate first.' }),
    expectedCurrentFingerprint: Sha256DigestSchema.nullable(),
  })
  .meta({ id: 'NodeCapTlsRotateArgs' })
const TlsRotateResult = z
  .strictObject({
    fingerprint: Sha256DigestSchema,
    previousFingerprint: Sha256DigestSchema.nullable(),
    notAfter: TimestampSchema,
    reloaded: z.boolean(),
    presentedFingerprint: Sha256DigestSchema.meta({
      description: 'What a fresh TLS connection to the instance presented after the reload.',
    }),
  })
  .meta({ id: 'NodeCapTlsRotateResult' })

// ----- roles (credentials-and-roles.md §4, §5) -----

const RoleAttributesSchema = z
  .strictObject({
    login: z.boolean().nullable(),
    inherit: z.boolean().nullable(),
    createdb: z.boolean().nullable(),
    createrole: z.boolean().nullable(),
    replication: z.boolean().nullable(),
    bypassrls: z.boolean().nullable(),
    connectionLimit: z.int().min(-1).max(100000).nullable(),
  })
  .meta({
    id: 'NodeRoleAttributes',
    description: 'null leaves an attribute as it is. SUPERUSER is never set by a capability.',
  })

const RolesInspectArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapRolesInspectArgs',
})
const RolesInspectResult = z
  .strictObject({
    rolesDigest: Sha256DigestSchema.meta({
      description: 'sha256 over the inspected roles, memberships and settings; apply binds it.',
    }),
    roles: z
      .array(
        z.strictObject({
          name: NameText,
          login: z.boolean(),
          superuser: z.boolean(),
          inherit: z.boolean(),
          createdb: z.boolean(),
          createrole: z.boolean(),
          replication: z.boolean(),
          bypassrls: z.boolean(),
          connectionLimit: z.int(),
          validUntil: TimestampSchema.nullable(),
          password: z.enum(['none', 'scram-sha-256', 'md5', 'other']),
        }),
      )
      .max(4096),
    memberships: z
      .array(
        z.strictObject({
          role: NameText,
          member: NameText,
          grantor: NameText.nullable(),
          admin: z.boolean(),
          inherit: z.boolean(),
          set: z.boolean(),
        }),
      )
      .max(16384),
    settings: z
      .array(
        z.strictObject({
          role: NameText.nullable(),
          database: NameText.nullable(),
          name: NameText,
          value: ValueText,
        }),
      )
      .max(4096),
  })
  .meta({ id: 'NodeCapRolesInspectResult' })

const RolesPlanArgs = z
  .strictObject({
    cluster: ClusterRefSchema,
    roles: z
      .array(
        z.strictObject({
          name: ManagedNameSchema,
          attributes: RoleAttributesSchema,
          memberOf: z
            .array(
              z.strictObject({
                role: ManagedNameSchema,
                admin: z.boolean(),
                inherit: z.boolean(),
                set: z.boolean(),
              }),
            )
            .max(64),
          settings: z
            .array(
              z.strictObject({
                name: ManagedParameterNameSchema,
                value: ParameterValueSchema,
                database: ManagedNameSchema.nullable(),
              }),
            )
            .max(64),
          passwordChange: z.boolean().meta({
            description: 'A new verifier will be installed; the verifier is never in a plan.',
          }),
        }),
      )
      .max(512)
      .meta({
        description: 'The desired roles of an exponetdb.roles/v1 manifest, without verifiers.',
      }),
  })
  .meta({ id: 'NodeCapRolesPlanArgs' })
const RolesPlanResult = z
  .strictObject({
    rolesDigest: Sha256DigestSchema,
    changes: z
      .array(
        z.strictObject({
          change: z.enum([
            'create_role',
            'alter_role',
            'set_password',
            'grant_membership',
            'revoke_membership',
            'set_role_setting',
            'reset_role_setting',
          ]),
          role: ManagedNameSchema,
          detail: untrustedText(1024, 'What changes, for the plan view.'),
          classification: z.enum(['standard', 'high', 'critical']),
        }),
      )
      .max(4096),
    unmanaged: z.array(NameText).max(4096).meta({
      description: 'Roles in the cluster that the manifest does not name; never changed.',
    }),
  })
  .meta({ id: 'NodeCapRolesPlanResult' })

/**
 * The members each role step takes besides `op` and `role` (required ones
 * must be non-null; every other member must be null). Both implementations
 * enforce this table.
 */
export const ROLE_STEP_MEMBERS = {
  create_role: { required: ['attributes'], optional: [] },
  alter_role: { required: ['attributes'], optional: [] },
  set_password: { required: ['verifier'], optional: [] },
  clear_password: { required: [], optional: [] },
  grant_membership: { required: ['member', 'admin', 'inherit', 'set'], optional: [] },
  revoke_membership: { required: ['member'], optional: [] },
  set_role_setting: { required: ['setting', 'value'], optional: ['database'] },
  reset_role_setting: { required: ['setting'], optional: ['database'] },
} as const satisfies Record<
  string,
  { readonly required: readonly string[]; readonly optional: readonly string[] }
>

const ROLE_STEP_OPTIONAL_MEMBERS = [
  'attributes',
  'verifier',
  'member',
  'admin',
  'inherit',
  'set',
  'database',
  'setting',
  'value',
] as const

export const RoleStepSchema = z
  .strictObject({
    op: z.enum([
      'create_role',
      'alter_role',
      'set_password',
      'clear_password',
      'grant_membership',
      'revoke_membership',
      'set_role_setting',
      'reset_role_setting',
    ]),
    role: ManagedNameSchema,
    attributes: RoleAttributesSchema.nullable().meta({
      description: 'create_role, alter_role only.',
    }),
    verifier: SealedValueSchema.nullable().meta({
      description: 'set_password only: a SCRAM-SHA-256 verifier sealed with field "verifier".',
    }),
    member: ManagedNameSchema.nullable().meta({
      description: 'grant_membership, revoke_membership only: the role that becomes a member.',
    }),
    admin: z.boolean().nullable(),
    inherit: z.boolean().nullable(),
    set: z.boolean().nullable(),
    database: ManagedNameSchema.nullable().meta({
      description: 'set_role_setting, reset_role_setting: null for all databases.',
    }),
    setting: ManagedParameterNameSchema.nullable(),
    value: ParameterValueSchema.nullable(),
  })
  .superRefine((step, ctx) => {
    const rule: { readonly required: readonly string[]; readonly optional: readonly string[] } =
      ROLE_STEP_MEMBERS[step.op]
    for (const member of ROLE_STEP_OPTIONAL_MEMBERS) {
      const present = step[member] !== null
      if (rule.required.includes(member) && !present) {
        ctx.addIssue({ code: 'custom', path: [member], message: `${step.op} needs ${member}` })
      }
      if (!rule.required.includes(member) && !rule.optional.includes(member) && present) {
        ctx.addIssue({ code: 'custom', path: [member], message: `${step.op} takes no ${member}` })
      }
    }
  })
  .meta({
    id: 'NodeRoleStep',
    description:
      'One typed step; the capability compiles it to SQL with escaped identifiers and literals. Members that do not belong to the op must be null.',
  })

const RolesApplyArgs = z
  .strictObject({
    cluster: ClusterRefSchema,
    expectedRolesDigest: Sha256DigestSchema,
    steps: z.array(RoleStepSchema).min(1).max(1024),
  })
  .meta({ id: 'NodeCapRolesApplyArgs' })
const RolesApplyResult = z
  .strictObject({
    rolesDigest: Sha256DigestSchema,
    appliedSteps: CountSchema,
  })
  .meta({ id: 'NodeCapRolesApplyResult' })

// ----- extensions -----

const ExtensionsInspectArgs = z
  .strictObject({ cluster: ClusterRefSchema, database: ManagedNameSchema })
  .meta({ id: 'NodeCapExtensionsInspectArgs' })
const InstalledExtensionSchema = z
  .strictObject({ name: NameText, version: NameText, schema: NameText })
  .meta({ id: 'NodeInstalledExtension' })
const ExtensionsInspectResult = z
  .strictObject({
    extensionsDigest: Sha256DigestSchema,
    installed: z.array(InstalledExtensionSchema).max(1024),
    available: z
      .array(
        z.strictObject({
          name: NameText,
          defaultVersion: NameText.nullable(),
          versions: z.array(NameText).max(256),
        }),
      )
      .max(2048),
  })
  .meta({ id: 'NodeCapExtensionsInspectResult' })

/** One extension step: create (with its schema) or update, never CASCADE. */
export const ExtensionStepSchema = z
  .strictObject({
    op: z.enum(['create', 'update']),
    name: ExtensionNameSchema,
    schema: ManagedNameSchema.nullable().meta({ description: 'create only.' }),
    version: ExtensionVersionSchema,
  })
  .refine((step) => (step.op === 'create') === (step.schema !== null), {
    message: 'create needs a schema; update takes none',
  })

const ExtensionsApplyArgs = z
  .strictObject({
    cluster: ClusterRefSchema,
    database: ManagedNameSchema,
    expectedExtensionsDigest: Sha256DigestSchema,
    steps: z
      .array(ExtensionStepSchema)
      .min(1)
      .max(64)
      .meta({ description: 'In order; never CASCADE: every dependency is its own step.' }),
  })
  .meta({ id: 'NodeCapExtensionsApplyArgs' })
const ExtensionsApplyResult = z
  .strictObject({
    extensionsDigest: Sha256DigestSchema,
    installed: z.array(InstalledExtensionSchema).max(1024),
  })
  .meta({ id: 'NodeCapExtensionsApplyResult' })

// ----- system -----

const SystemHealthResult = z
  .strictObject({
    load1: z.number().min(0),
    load5: z.number().min(0),
    load15: z.number().min(0),
    memoryTotalBytes: BytesSchema,
    memoryAvailableBytes: BytesSchema,
    swapTotalBytes: BytesSchema,
    swapUsedBytes: BytesSchema,
    mounts: z.array(MountSchema).max(64),
    ntpSynchronized: z.boolean(),
    failedUnits: z.array(NameText).max(64),
  })
  .meta({ id: 'NodeCapSystemHealthResult' })

const RebootRequiredResult = z
  .strictObject({ required: z.boolean(), packages: z.array(NameText).max(256) })
  .meta({ id: 'NodeCapRebootRequiredResult' })

const DiskStatsArgs = z
  .strictObject({ cluster: ClusterRefSchema.nullable() })
  .meta({ id: 'NodeCapDiskStatsArgs' })
const DiskStatsResult = z
  .strictObject({
    mounts: z.array(MountSchema).max(64),
    breakdown: z
      .array(
        z.strictObject({
          category: z.enum(['data', 'wal', 'logs', 'temp', 'other']),
          bytes: BytesSchema,
        }),
      )
      .max(8)
      .meta({ description: 'For the cluster in the arguments; empty without one.' }),
  })
  .meta({ id: 'NodeCapDiskStatsResult' })

const MemoryStatsResult = z
  .strictObject({
    totalBytes: BytesSchema,
    availableBytes: BytesSchema,
    usedBytes: BytesSchema,
    cachedBytes: BytesSchema,
    swapTotalBytes: BytesSchema,
    swapUsedBytes: BytesSchema,
  })
  .meta({ id: 'NodeCapMemoryStatsResult' })

const CpuStatsResult = z
  .strictObject({
    cpus: z.int().min(1),
    load1: z.number().min(0),
    load5: z.number().min(0),
    load15: z.number().min(0),
    userPercent: PercentSchema,
    systemPercent: PercentSchema,
    iowaitPercent: PercentSchema,
    idlePercent: PercentSchema,
  })
  .meta({ id: 'NodeCapCpuStatsResult' })

const ServiceStatusResult = z
  .strictObject({
    units: z
      .array(
        z.strictObject({
          unit: NameText,
          kind: z.enum(['postgresql', 'agent', 'helper']),
          activeState: untrustedText(32, 'systemd ActiveState'),
          subState: untrustedText(32, 'systemd SubState'),
          since: TimestampSchema.nullable(),
        }),
      )
      .max(64)
      .meta({ description: 'The allowlisted units only.' }),
  })
  .meta({ id: 'NodeCapServiceStatusResult' })

/**
 * a < b for two contract timestamps at nanosecond precision, digits beyond
 * the ninth ignored: the same order the Go agent's time.Parse gives.
 */
export function timestampBefore(a: string, b: string): boolean {
  const split = (t: string): readonly [number, string] => {
    const dot = t.indexOf('.')
    const whole = dot === -1 ? t.slice(0, -1) : t.slice(0, dot)
    const fraction = dot === -1 ? '' : t.slice(dot + 1, -1)
    return [Date.parse(`${whole}Z`), fraction.slice(0, 9).padEnd(9, '0')]
  }
  const [secondsA, fractionA] = split(a)
  const [secondsB, fractionB] = split(b)
  return secondsA !== secondsB ? secondsA < secondsB : fractionA < fractionB
}

const LogInspectArgs = z
  .strictObject({
    source: z.enum(['postgresql', 'agent', 'helper']),
    cluster: ClusterRefSchema.nullable().meta({ description: 'Required for postgresql.' }),
    since: TimestampSchema,
    until: TimestampSchema,
    minSeverity: z.enum(['debug', 'info', 'notice', 'warning', 'error', 'fatal', 'panic']),
    maxLines: z.int().min(1).max(500),
  })
  .refine((a) => (a.source === 'postgresql') === (a.cluster !== null), {
    message: 'postgresql logs need a cluster; agent and helper logs take none',
  })
  .refine((a) => timestampBefore(a.since, a.until), {
    message: 'since must be before until',
  })
  .meta({ id: 'NodeCapLogInspectArgs' })
const LogInspectResult = z
  .strictObject({
    lines: z
      .array(
        z.strictObject({
          at: TimestampSchema.nullable(),
          severity: untrustedText(16, 'Severity as logged.').nullable(),
          text: untrustedText(2048, 'The line, redacted on the host.'),
        }),
      )
      .max(500),
    truncated: z.boolean(),
  })
  .meta({ id: 'NodeCapLogInspectResult' })

// ----- WAL (observation only in Wave 5) -----

const WalStatusArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapWalStatusArgs',
})
const WalStatusResult = z
  .strictObject({
    currentLsn: LsnSchema.nullable().meta({ description: 'null on a standby.' }),
    walDirectoryBytes: BytesSchema,
    maxWalSize: untrustedText(32, 'max_wal_size with unit'),
    slots: z
      .array(
        z.strictObject({
          name: NameText,
          active: z.boolean(),
          walStatus: untrustedText(16, 'pg_replication_slots.wal_status').nullable(),
          retainedBytes: BytesSchema.nullable(),
        }),
      )
      .max(64),
    walRecords: CountSchema.nullable(),
    walBytes: BytesSchema.nullable(),
  })
  .meta({ id: 'NodeCapWalStatusResult' })

const WalArchiveStatusArgs = z.strictObject({ cluster: ClusterRefSchema }).meta({
  id: 'NodeCapWalArchiveStatusArgs',
})
const WalArchiveStatusResult = z
  .strictObject({
    archiveMode: untrustedText(16, 'archive_mode'),
    archivedCount: CountSchema,
    failedCount: CountSchema,
    lastArchivedWal: NameText.nullable(),
    lastArchivedAt: TimestampSchema.nullable(),
    lastFailedWal: NameText.nullable(),
    lastFailedAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'NodeCapWalArchiveStatusResult' })

// ----- packages (audit and planning only in Wave 5) -----

const PackageNameSchema = z.string().regex(/^[a-z0-9][a-z0-9+.-]{1,63}$/)
const PackageVersionSchema = z.string().regex(/^[0-9A-Za-z.+~:-]{1,64}$/)

const PackagesAuditResult = z
  .strictObject({
    packages: z
      .array(
        z.strictObject({
          name: PackageNameSchema,
          installed: PackageVersionSchema.nullable(),
          candidate: PackageVersionSchema.nullable(),
          security: z.boolean(),
        }),
      )
      .max(64)
      .meta({ description: 'The allowlisted packages only.' }),
  })
  .meta({ id: 'NodeCapPackagesAuditResult' })

const PackagesPlanArgs = z
  .strictObject({
    packages: z
      .array(z.strictObject({ name: PackageNameSchema, version: PackageVersionSchema }))
      .min(1)
      .max(16),
  })
  .meta({ id: 'NodeCapPackagesPlanArgs' })
const PackagesPlanResult = z
  .strictObject({
    changes: z
      .array(
        z.strictObject({
          name: PackageNameSchema,
          action: z.enum(['upgrade', 'install', 'remove']),
          from: PackageVersionSchema.nullable(),
          to: PackageVersionSchema.nullable(),
          allowlisted: z.boolean(),
        }),
      )
      .max(256),
    restartsPostgresql: z.boolean(),
    postgresqlMajorChange: z
      .boolean()
      .meta({ description: 'Always refused as a plan: a major change is never a package update.' }),
  })
  .meta({ id: 'NodeCapPackagesPlanResult' })

// ----- agent self-management -----

const ConfigUpdateArgs = z
  .strictObject({
    gateway: z
      .strictObject({
        url: z
          .string()
          .max(270)
          .regex(
            /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[1-9][0-9]{0,4})?$/,
          )
          .meta({
            description:
              'As the token gateway (protocol.md §7.3): port 1 to 65535, never written as 443.',
          }),
        serverName: DnsNameSchema,
      })
      .nullable(),
    addJobKeys: z.array(z.strictObject({ keyId: KeyIdSchema, publicKey: PublicKeySchema })).max(2),
    retireJobKeys: z.array(KeyIdSchema).max(2),
  })
  .meta({
    id: 'NodeCapConfigUpdateArgs',
    description:
      'Agent-owned state only (job keys, gateway address); never the root-owned operator configuration (G5 record C8). The agent keeps at least one and at most three job keys.',
  })
const ConfigUpdateResult = z
  .strictObject({
    gatewayUrl: z.string().max(270),
    jobKeys: z.array(KeyIdSchema).min(1).max(3),
  })
  .meta({ id: 'NodeCapConfigUpdateResult' })

const AgentDiagnosticsResult = z
  .strictObject({
    agentVersion: SemverSchema,
    journal: z.strictObject({
      entries: CountSchema,
      bytes: BytesSchema,
      oldestAt: TimestampSchema.nullable(),
    }),
    nonceCache: z.strictObject({ entries: CountSchema, bytes: BytesSchema }),
    bufferedResults: CountSchema,
    lastErrors: z.array(untrustedText(512, 'Redacted on the host.')).max(16),
  })
  .meta({ id: 'NodeCapAgentDiagnosticsResult' })

// ----- the catalog -----

export const CAPABILITY_KINDS = ['read', 'plan', 'apply'] as const
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]

/** Reconciliation after an unknown outcome (protocol.md §4.4). */
export const CAPABILITY_RECONCILE = ['none', 'idempotent', 'observable', 'manual'] as const
export type CapabilityReconcile = (typeof CAPABILITY_RECONCILE)[number]

export interface NodeCapabilityDefinition {
  readonly name: string
  readonly major: number
  readonly kind: CapabilityKind
  /** Who executes it: the unprivileged agent, the root helper, or both. */
  readonly path: 'agent' | 'helper' | 'agent_and_helper'
  readonly reconcile: CapabilityReconcile
  /**
   * The step at which the capability first changes the host. A cancel seen
   * before it completes the job `canceled`; after it the job finishes and
   * reports its effect (ADR-0024 §5). null: no effect (read and plan).
   */
  readonly effectStep: string | null
  /** Argument paths whose values must be sealed (`ns1`) with the given field name. */
  readonly sealedFields: readonly { readonly path: string; readonly field: string }[]
  /**
   * How long the agent runs the job after its start: at this deadline it
   * stops the capability (a statement in flight is canceled, a helper call
   * abandoned) and states the job; the Control Plane counts on it
   * ([control-plane.md §9.4](../../../../exponetdb-docs/07-node-agent/control-plane.md#94-execution-and-outcomes)).
   */
  readonly runSeconds: number
  /**
   * How long an effect the job began can still land after the job ended:
   * the root helper's queue wait (30 s), its command limit and the kill
   * delay (5 s); for the agent's own SQL, the statement timeout (60 s).
   * Reconciliation never judges the host by its basis state before then.
   */
  readonly settleSeconds: number
  readonly args: z.ZodType
  readonly result: z.ZodType
}

function capability(
  name: string,
  kind: CapabilityKind,
  path: NodeCapabilityDefinition['path'],
  args: z.ZodType,
  result: z.ZodType,
  extra: Partial<
    Pick<
      NodeCapabilityDefinition,
      'reconcile' | 'effectStep' | 'sealedFields' | 'runSeconds' | 'settleSeconds'
    >
  > = {},
): NodeCapabilityDefinition {
  return {
    name,
    major: 1,
    kind,
    path,
    reconcile: extra.reconcile ?? 'none',
    effectStep: extra.effectStep ?? null,
    sealedFields: extra.sealedFields ?? [],
    // The helper's commands are limited to 60 s (a restart to 10 minutes).
    runSeconds: extra.runSeconds ?? 300,
    settleSeconds: extra.settleSeconds ?? 95,
    args,
    result,
  }
}

/** The Wave 5 capabilities, keyed `name@major`. */
export const NODE_CAPABILITIES = {
  'postgres.status@1': capability(
    'postgres.status',
    'read',
    'agent',
    PostgresStatusArgs,
    PostgresStatusResult,
  ),
  'postgres.reload@1': capability(
    'postgres.reload',
    'apply',
    'agent',
    PostgresReloadArgs,
    PostgresReloadResult,
    { reconcile: 'idempotent', effectStep: 'reload' },
  ),
  'postgres.restart.plan@1': capability(
    'postgres.restart.plan',
    'plan',
    'agent',
    PostgresRestartPlanArgs,
    PostgresRestartPlanResult,
  ),
  'postgres.restart@1': capability(
    'postgres.restart',
    'apply',
    'helper',
    PostgresRestartArgs,
    PostgresRestartResult,
    { reconcile: 'observable', effectStep: 'restart', runSeconds: 720, settleSeconds: 635 },
  ),
  'postgres.config.inspect@1': capability(
    'postgres.config.inspect',
    'read',
    'agent',
    ConfigInspectArgs,
    ConfigInspectResult,
  ),
  'postgres.config.plan@1': capability(
    'postgres.config.plan',
    'plan',
    'agent',
    ConfigPlanArgs,
    ConfigPlanResult,
  ),
  'postgres.config.apply@1': capability(
    'postgres.config.apply',
    'apply',
    'agent_and_helper',
    ConfigApplyArgs,
    ConfigApplyResult,
    { reconcile: 'idempotent', effectStep: 'write_fragment' },
  ),
  'postgres.hba.inspect@1': capability(
    'postgres.hba.inspect',
    'read',
    'agent',
    HbaInspectArgs,
    HbaInspectResult,
  ),
  'postgres.hba.apply@1': capability(
    'postgres.hba.apply',
    'apply',
    'agent_and_helper',
    HbaApplyArgs,
    HbaApplyResult,
    { reconcile: 'idempotent', effectStep: 'write_file' },
  ),
  'postgres.tls.inspect@1': capability(
    'postgres.tls.inspect',
    'read',
    'agent',
    TlsInspectArgs,
    TlsInspectResult,
  ),
  'postgres.tls.plan@1': capability(
    'postgres.tls.plan',
    'plan',
    'agent_and_helper',
    TlsPlanArgs,
    TlsPlanResult,
  ),
  'postgres.tls.rotate@1': capability(
    'postgres.tls.rotate',
    'apply',
    'agent_and_helper',
    TlsRotateArgs,
    TlsRotateResult,
    { reconcile: 'idempotent', effectStep: 'install' },
  ),
  'postgres.roles.inspect@1': capability(
    'postgres.roles.inspect',
    'read',
    'agent',
    RolesInspectArgs,
    RolesInspectResult,
  ),
  'postgres.roles.plan@1': capability(
    'postgres.roles.plan',
    'plan',
    'agent',
    RolesPlanArgs,
    RolesPlanResult,
  ),
  'postgres.roles.apply@1': capability(
    'postgres.roles.apply',
    'apply',
    'agent',
    RolesApplyArgs,
    RolesApplyResult,
    {
      reconcile: 'idempotent',
      effectStep: 'execute',
      sealedFields: [{ path: 'steps[].verifier', field: 'verifier' }],
    },
  ),
  'postgres.extensions.inspect@1': capability(
    'postgres.extensions.inspect',
    'read',
    'agent',
    ExtensionsInspectArgs,
    ExtensionsInspectResult,
  ),
  'postgres.extensions.apply@1': capability(
    'postgres.extensions.apply',
    'apply',
    'agent',
    ExtensionsApplyArgs,
    ExtensionsApplyResult,
    { reconcile: 'idempotent', effectStep: 'execute' },
  ),
  'system.health@1': capability(
    'system.health',
    'read',
    'agent',
    NoArgsSchema('NodeCapSystemHealthArgs'),
    SystemHealthResult,
  ),
  'system.reboot_required@1': capability(
    'system.reboot_required',
    'read',
    'agent',
    NoArgsSchema('NodeCapRebootRequiredArgs'),
    RebootRequiredResult,
  ),
  'disk.stats@1': capability('disk.stats', 'read', 'agent', DiskStatsArgs, DiskStatsResult),
  'memory.stats@1': capability(
    'memory.stats',
    'read',
    'agent',
    NoArgsSchema('NodeCapMemoryStatsArgs'),
    MemoryStatsResult,
  ),
  'cpu.stats@1': capability(
    'cpu.stats',
    'read',
    'agent',
    NoArgsSchema('NodeCapCpuStatsArgs'),
    CpuStatsResult,
  ),
  'service.status@1': capability(
    'service.status',
    'read',
    'helper',
    NoArgsSchema('NodeCapServiceStatusArgs'),
    ServiceStatusResult,
  ),
  'log.inspect@1': capability('log.inspect', 'read', 'agent', LogInspectArgs, LogInspectResult),
  'wal.status@1': capability('wal.status', 'read', 'agent', WalStatusArgs, WalStatusResult),
  'wal.archive_status@1': capability(
    'wal.archive_status',
    'read',
    'agent',
    WalArchiveStatusArgs,
    WalArchiveStatusResult,
  ),
  'packages.audit@1': capability(
    'packages.audit',
    'read',
    'helper',
    NoArgsSchema('NodeCapPackagesAuditArgs'),
    PackagesAuditResult,
  ),
  'packages.plan_update@1': capability(
    'packages.plan_update',
    'plan',
    'helper',
    PackagesPlanArgs,
    PackagesPlanResult,
  ),
  'config.update@1': capability(
    'config.update',
    'apply',
    'agent',
    ConfigUpdateArgs,
    ConfigUpdateResult,
    // Not idempotent: the same arguments again are refused (the keys are
    // already trusted or retired). Observable: a job signed with the new key
    // is accepted, or refused unknown_signing_key.
    { reconcile: 'observable', effectStep: 'write_state' },
  ),
  'agent.diagnostics@1': capability(
    'agent.diagnostics',
    'read',
    'agent',
    NoArgsSchema('NodeCapAgentDiagnosticsArgs'),
    AgentDiagnosticsResult,
  ),
} as const satisfies Record<string, NodeCapabilityDefinition>

export type NodeCapabilityKey = keyof typeof NODE_CAPABILITIES
export const NODE_CAPABILITY_KEYS = Object.keys(NODE_CAPABILITIES) as NodeCapabilityKey[]

export function isNodeCapabilityKey(value: string): value is NodeCapabilityKey {
  return Object.hasOwn(NODE_CAPABILITIES, value)
}
