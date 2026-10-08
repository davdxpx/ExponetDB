// Generated from packages/contracts (OpenAPI 3.1) by tooling/generators/sdk.ts.
// Do not edit by hand: run `bun run generate` (CI checks it is current).

export type AccessRole = "observer" | "reader" | "verifier" | "operator" | "migrator"

export type Actor = {
  readonly identityId: string
  readonly kind: "human" | "service"
  readonly via: "web" | "rest" | "mcp" | "cli"
}

export type AdvisorRun = {
  readonly findings: ReadonlyArray<{
    readonly category: "security" | "performance"
    readonly level: "info" | "warning" | "critical"
    readonly message: string
    readonly object: string | null
    readonly remediation: string
    readonly rule: string
  }>
  readonly ranAt: string
  readonly targetId: string
}

export type AdvisorRunRequest = {
  readonly categories?: ReadonlyArray<"security" | "performance">
}

export type ApiKey = {
  readonly createdAt: string
  readonly createdBy: string
  readonly expiresAt: string
  readonly id: string
  readonly label: string | null
  readonly lastUsedAt: string | null
  readonly restrictions: GrantRestrictions
  readonly revokedAt: string | null
  readonly scopes: ReadonlyArray<"targets.read" | "schema.read" | "diagnostics.read" | "data.read:nonprod" | "data.read:prod" | "migrations.read" | "migrations.plan" | "migrations.apply:nonprod" | "migrations.apply:prod" | "connections.operate:nonprod" | "connections.operate:prod" | "backups.read" | "backups.run" | "restore.plan" | "nodes.read" | "nodes.plan" | "nodes.operate:nonprod" | "nodes.operate:prod" | "audit.read" | "api" | "registry.manage" | "access.read" | "access.manage" | "policy.manage" | "restore.execute" | "plans.approve" | "operations.recover" | "breakglass.activate" | "diagnostics.read_sensitive" | "data.read_sensitive" | "migrations.import" | "schema.manage">
  readonly serviceAccountId: string
  readonly state: "active" | "revoked" | "expired"
}

export type ApiKeyCreateRequest = {
  readonly acknowledgeProductionWrite?: true
  readonly label?: string
  readonly lifetimeDays: number
  readonly restrictions: GrantRestrictions
  readonly scopes: ReadonlyArray<"targets.read" | "schema.read" | "diagnostics.read" | "data.read:nonprod" | "data.read:prod" | "migrations.read" | "migrations.plan" | "migrations.apply:nonprod" | "migrations.apply:prod" | "connections.operate:nonprod" | "connections.operate:prod" | "backups.read" | "backups.run" | "restore.plan" | "nodes.read" | "nodes.plan" | "nodes.operate:nonprod" | "nodes.operate:prod" | "audit.read" | "api" | "registry.manage" | "access.read" | "access.manage" | "policy.manage" | "restore.execute" | "plans.approve" | "operations.recover" | "breakglass.activate" | "diagnostics.read_sensitive" | "data.read_sensitive" | "migrations.import" | "schema.manage">
}

export type ApiKeyCreated = {
  readonly apiKey: ApiKey
  readonly secret: string
}

export type ApplyOutcome = "not_started" | "applied" | "not_applied" | "partially_applied" | "unknown"

export type Approval = {
  readonly approverIdentityId: string
  readonly decidedAt: string
  readonly decision: "approved" | "rejected"
  readonly id: string
  readonly notBefore: string
  readonly operationId: string
  readonly planHash: string
  readonly planId: string
  readonly selfApproval: boolean
}

export type ApprovalQueueItem = {
  readonly actorClient: "web" | "rest" | "mcp" | "cli" | "ci" | "system"
  readonly actorIdentityId: string | null
  readonly approvals: readonly Approval[]
  readonly change?: {
    readonly analysis: JsonValue
    readonly content: JsonValue
  }
  readonly class: "read" | "low" | "standard" | "high" | "critical"
  readonly kind: "installation.get" | "installation.health.get" | "product.list" | "product.get" | "environment.list" | "project.list" | "project.get" | "target.list" | "target.get" | "target.health.get" | "target.finding.list" | "schema.overview.get" | "schema.object.get" | "schema.search" | "schema.fingerprint.get" | "schema.diff" | "query.run" | "query.explain" | "migration.lint" | "migration.status.get" | "session.list" | "lock.list" | "query_stats.list" | "table_stats.list" | "advisor.run" | "server.list" | "server.get" | "cluster.list" | "cluster.get" | "node.list" | "node.get" | "backup.list" | "audit.search" | "plan.get" | "operation.get" | "operation.list" | "drift.check" | "migration.plan" | "migration.rollback.plan" | "migration.bundle.ingest" | "migration.import.analyze" | "migration.baseline.plan" | "ledger.reconcile.plan" | "connections.terminate.plan" | "node.plan" | "restore.plan" | "plan.withdraw" | "approval.approve" | "approval.reject" | "breakglass.activate" | "plan.apply" | "target.register" | "target.suspend" | "target.resume" | "target.decommission" | "target.identity.stamp" | "ledger.initialize" | "credential.rotate" | "migration.apply" | "migration.verify" | "migration.rollback" | "migration.baseline" | "migration.resume" | "migration.rebaseline" | "ledger.reconcile" | "drift.accept" | "operation.force_release" | "connections.cancel" | "connections.terminate" | "postgres.config.apply" | "postgres.reload" | "postgres.restart" | "postgres.tls.rotate" | "postgres.roles.apply" | "postgres.extensions.apply" | "postgres.hba.apply" | "packages.apply_update" | "backup.run" | "backup.verify" | "restore.execute" | "node.enroll" | "node.revoke" | "node.decommission" | "node.enroll.plan" | "node.revoke.plan" | "node.config.update.plan" | "node.decommission.plan" | "credential.rotate.plan" | "node.inspect" | "node.enrollment_token.reveal" | "node.config.update" | "access.role_binding.create" | "access.role_binding.delete" | "access.policy_settings.update" | "auth.login" | "auth.enrollment" | "me.get" | "auth.session.list" | "auth.factor.list" | "auth.logout" | "auth.reauth" | "auth.session.revoke" | "auth.passkey.add" | "auth.passkey.remove" | "auth.password.change" | "auth.totp.replace" | "auth.recovery_codes.regenerate" | "identity.list" | "identity.get" | "role.list" | "role.get" | "role_binding.list" | "policy_settings.get" | "approval.list" | "access.identity.invite" | "access.invitation.reissue" | "access.identity.disable" | "access.identity.enable" | "access.identity.erase" | "access.role_binding.create.plan" | "access.role_binding.delete.plan" | "access.policy_settings.update.plan" | "access.identity.enable.plan" | "access.identity.erase.plan" | "endpoint.list" | "database.list" | "credential.list" | "cluster.bootstrap_sql.get" | "registry.product.create.plan" | "registry.environment.create.plan" | "registry.environment.update.plan" | "registry.project.create.plan" | "registry.project.update.plan" | "registry.server.create.plan" | "registry.cluster.register.plan" | "registry.cluster.confirm.plan" | "registry.endpoint.add.plan" | "registry.endpoint.retire.plan" | "registry.database.register.plan" | "target.register.plan" | "target.suspend.plan" | "target.resume.plan" | "target.decommission.plan" | "registry.product.create" | "registry.environment.create" | "registry.environment.update" | "registry.project.create" | "registry.project.update" | "registry.server.create" | "registry.cluster.register" | "registry.cluster.confirm" | "registry.endpoint.add" | "registry.endpoint.retire" | "registry.database.register" | "registry.credential.submit" | "oauth.metadata.get" | "oauth.authorize" | "oauth.token" | "oauth.revoke" | "oauth.register" | "oauth.device_authorization" | "oauth.consent.get" | "oauth.consent" | "oauth.grant.list_own" | "oauth.grant.revoke_own" | "oauth.client.list" | "oauth.client.get" | "oauth.client.register_cimd" | "oauth.client.refresh_metadata" | "oauth.client.approve" | "oauth.client.reject" | "oauth.client.disable" | "oauth.grant.list" | "oauth.grant.revoke" | "service_account.list" | "service_account.get" | "service_account.create" | "service_account.client.register" | "service_account.client.keys.replace" | "service_account.grant.create" | "api_key.list" | "api_key.create" | "api_key.revoke"
  readonly operationId: string
  readonly ownPlan: boolean
  readonly planHash: string
  readonly planId: string
  readonly requestedAt: string
  readonly required: number
  readonly tier: "prod" | "nonprod" | null
}

export type AuditEvent = {
  readonly action: string
  readonly actor: {
    readonly identityId: string | null
    readonly kind: "human" | "service" | "system"
    readonly label: string
  }
  readonly client: ({
    readonly clientId: string | null
    readonly grantId: string | null
    readonly kind: "web" | "rest" | "mcp" | "cli" | "ci" | "system"
    readonly sessionId: string | null
  }) | null
  readonly id: string
  readonly occurredAt: string
  readonly phase: "requested" | "denied" | "accepted" | "completed" | "failed" | "reconciled"
  readonly reason: string | null
  readonly refs: {
    readonly jobId: string | null
    readonly operationId: string | null
    readonly planHash: string | null
    readonly planId: string | null
  }
  readonly result: {
    readonly errorCode: string | null
    readonly status: "succeeded" | "failed" | "denied"
  }
  readonly subject: SubjectRef
}

export type AuthFactor = ({
  readonly backedUp: boolean
  readonly createdAt: string
  readonly deviceType: "singleDevice" | "multiDevice"
  readonly id: string
  readonly kind: "passkey"
  readonly label: string
  readonly lastUsedAt: string | null
}) | ({
  readonly createdAt: string
  readonly id: string
  readonly kind: "password"
}) | ({
  readonly createdAt: string
  readonly id: string
  readonly kind: "totp"
  readonly lastUsedAt: string | null
}) | ({
  readonly createdAt: string
  readonly id: string
  readonly kind: "recovery_codes"
  readonly remaining: number
})

export type Backup = {
  readonly finishedAt: string | null
  readonly id: string
  readonly kind: "full" | "differential" | "incremental" | "logical"
  readonly sizeBytes: number | null
  readonly startedAt: string
  readonly state: "running" | "succeeded" | "failed"
  readonly verification: {
    readonly state: "pending" | "passed" | "failed"
    readonly verifiedAt: string | null
  }
}

export type BackupCatalog = {
  readonly achievableRpoSeconds: number | null
  readonly backups: readonly Backup[]
  readonly clusterId: string
  readonly lastDrillAt: string | null
  readonly observedAt: string
  readonly source: string
  readonly state: BackupHealthState
  readonly truncated: boolean
  readonly walWindow: ({
    readonly from: string
    readonly to: string
  }) | null
}

export type BackupHealthState = "protected" | "at_risk" | "unprotected" | "unproven" | "unknown"

export type BindingScope = ({
  readonly kind: "global"
}) | ({
  readonly kind: "product"
  readonly productId: string
}) | ({
  readonly kind: "project"
  readonly projectId: string
}) | ({
  readonly environmentId: string
  readonly kind: "environment"
}) | ({
  readonly kind: "target"
  readonly targetId: string
})

export type CapabilityRef = {
  readonly major: number
  readonly name: string
}

export type CimdClientRequest = {
  readonly clientId: string
}

export type ClientApprovalRequest = {
  readonly fingerprint: string
}

export type ClientDecisionReason = {
  readonly reason?: string
}

export type Cluster = {
  readonly confirmedAt: string | null
  readonly derivedTier: "prod" | "nonprod" | null
  readonly displayName: string
  readonly health: HealthSummary | null
  readonly id: string
  readonly managementMode: "agent" | "external"
  readonly postgresVersion: string | null
  readonly serverId: string | null
  readonly state: "pending" | "active" | "retired"
  readonly systemIdentifier: string | null
}

export type ClusterBootstrapSql = {
  readonly clusterId: string
  readonly databases: readonly string[]
  readonly roles: readonly string[]
  readonly script: string
}

export type ClusterConfirmRequest = {
  readonly systemIdentifier?: string
}

export type ClusterRegisterRequest = {
  readonly caBundle: string
  readonly displayName: string
  readonly endpoints: readonly EndpointRequest[]
  readonly serverId?: string
}

export type ControlPlaneHealthState = "operational" | "degraded" | "down"

export type CredentialSubmission = {
  readonly password: string
}

export type CredentialView = {
  readonly accessRole: AccessRole
  readonly clusterId: string
  readonly failureCode: string | null
  readonly id: string
  readonly roleName: string
  readonly state: "pending" | "active" | "retired" | "failed"
  readonly stateChangedAt: string
  readonly submittedAt: string
  readonly submittedBy: string
  readonly verifiedAt: string | null
  readonly version: number
}

export type DatabaseRegisterRequest = {
  readonly name: string
}

export type DatabaseView = {
  readonly clusterId: string
  readonly createdAt: string
  readonly id: string
  readonly name: string
  readonly observed: ({
    readonly collation: string
    readonly encoding: string
    readonly observedAt: string
    readonly owner: string
  }) | null
  readonly placement: ({
    readonly generation: number
    readonly targetId: string
  }) | null
  readonly state: "registered" | "retired"
}

export type DriftCheck = {
  readonly baselineFingerprint: string | null
  readonly checkedAt: string
  readonly counts: {
    readonly drifted: number
    readonly matched: number
    readonly opened: number
    readonly resolved: number
    readonly unmanaged: number
    readonly updated: number
  }
  readonly currentFingerprint: string | null
  readonly errorCode: string | null
  readonly findings: readonly DriftFinding[]
  readonly id: string
  readonly status: string
  readonly targetId: string
  readonly truncated: boolean
}

export type DriftFinding = {
  readonly actual: string | null
  readonly bucket: "drifted" | "matched" | "unmanaged"
  readonly code: string
  readonly driftKind: "A" | "B" | "C" | "D" | "E" | "F"
  readonly expected: string | null
  readonly explainedByOperationId: string | null
  readonly id: string
  readonly object: string | null
  readonly severity: "info" | "warning" | "critical"
}

export type EffectivePermission = {
  readonly permission: "targets.read" | "schema.read" | "schema.manage" | "diagnostics.read" | "diagnostics.read_sensitive" | "data.read" | "data.read_sensitive" | "migrations.read" | "migrations.plan" | "migrations.apply" | "migrations.import" | "connections.operate" | "backups.read" | "backups.run" | "restore.plan" | "restore.execute" | "nodes.read" | "nodes.plan" | "nodes.operate" | "plans.approve" | "operations.recover" | "breakglass.activate" | "audit.read" | "registry.manage" | "access.read" | "access.manage" | "policy.manage"
  readonly scopes: readonly BindingScope[]
}

export type EndpointKind = "private" | "public" | "local_socket" | "pooler"

export type EndpointRequest = {
  readonly host: string
  readonly kind: EndpointKind
  readonly label: string
  readonly poolerMode?: "session" | "transaction"
  readonly port: number
  readonly tlsServerName?: string
}

export type EndpointRetireRequest = {
  readonly reason?: string
}

export type EndpointView = {
  readonly clusterId: string
  readonly createdAt: string
  readonly host: string
  readonly id: string
  readonly kind: EndpointKind
  readonly label: string
  readonly poolerMode: "session" | "transaction" | null
  readonly port: number
  readonly retiredAt: string | null
  readonly state: "active" | "retired"
  readonly tlsServerName: string
}

export type EnrollmentTokenReveal = {
  readonly expiresAt: string
  readonly serverId: string
  readonly token: string
  readonly tokenId: string
}

export type Environment = {
  readonly displayName: string
  readonly evidenceFrom: string | null
  readonly id: string
  readonly productId: string
  readonly rank: number
  readonly revision: number
  readonly slug: string
  readonly tier: "prod" | "nonprod"
}

export type EnvironmentChangeRequest = {
  readonly displayName?: string
  readonly evidenceFrom?: string | null
  readonly rank?: number
  readonly tier?: "prod" | "nonprod"
}

export type EnvironmentCreateRequest = {
  readonly displayName: string
  readonly evidenceFrom?: string | null
  readonly rank?: number
  readonly slug: string
  readonly tier: "prod" | "nonprod"
}

export type ExplainRequest = {
  readonly analyze?: boolean
  readonly params?: readonly unknown[]
  readonly sql: string
}

export type ExplainResult = {
  readonly durationMs: number
  readonly plan: JsonValue
  readonly summary: {
    readonly actualRows: unknown
    readonly misestimates: ReadonlyArray<{
      readonly actual: number
      readonly estimated: number
      readonly node: string
    }>
    readonly planRows: number
    readonly sequentialScans: readonly string[]
    readonly totalCost: number
  }
}

export type FactorSummary = {
  readonly passkeys: number
  readonly password: boolean
  readonly recoveryCodesRemaining: number
  readonly totp: boolean
}

export type Finding = {
  readonly code: string
  readonly firstSeenAt: string
  readonly id: string
  readonly kind: string
  readonly lastSeenAt: string
  readonly object: string | null
  readonly occurrences: number
  readonly resolution: string | null
  readonly resolvedAt: string | null
  readonly securityRelevant: boolean
  readonly severity: "info" | "warning" | "critical"
  readonly state: "open" | "resolved"
  readonly subject: {
    readonly clusterId: string | null
    readonly nodeId: string | null
    readonly targetId: string | null
  }
  readonly summary: string
}

export type Grant = {
  readonly client: OAuthClientSummary
  readonly consentAt: string | null
  readonly createdAt: string
  readonly expiresAt: string
  readonly id: string
  readonly identityId: string
  readonly kind: "delegated" | "machine"
  readonly lastTokenAt: string | null
  readonly resource: "api" | "mcp"
  readonly resourceUri: string
  readonly restrictions: GrantRestrictions
  readonly revokeReason: string | null
  readonly revokedAt: string | null
  readonly scopes: ReadonlyArray<"targets.read" | "schema.read" | "diagnostics.read" | "data.read:nonprod" | "data.read:prod" | "migrations.read" | "migrations.plan" | "migrations.apply:nonprod" | "migrations.apply:prod" | "connections.operate:nonprod" | "connections.operate:prod" | "backups.read" | "backups.run" | "restore.plan" | "nodes.read" | "nodes.plan" | "nodes.operate:nonprod" | "nodes.operate:prod" | "audit.read" | "api" | "registry.manage" | "access.read" | "access.manage" | "policy.manage" | "restore.execute" | "plans.approve" | "operations.recover" | "breakglass.activate" | "diagnostics.read_sensitive" | "data.read_sensitive" | "migrations.import" | "schema.manage">
  readonly state: GrantState
}

export type GrantRestrictions = {
  readonly targets: TargetRestriction
  readonly tiers: ReadonlyArray<"prod" | "nonprod">
}

export type GrantState = "active" | "revoked" | "expired"

export type HealthCondition = {
  readonly condition: string
  readonly count: number | null
  readonly endpointId?: string | null
  readonly observedAt: string
  readonly severity: "info" | "warning" | "critical"
  readonly values?: {
    readonly [key: string]: unknown
  }
}

export type HealthSummary = {
  readonly observedAt: string
  readonly source: string
  readonly state: TargetHealthState
}

export type Identity = {
  readonly activatedAt: string | null
  readonly createdAt: string
  readonly displayName: string | null
  readonly email: string | null
  readonly factors: FactorSummary
  readonly id: string
  readonly kind: "human" | "service"
  readonly label: string
  readonly recoveryRequired: boolean
  readonly state: IdentityState
}

export type IdentityState = "invited" | "active" | "disabled" | "erased"

export type InspectableCapability = "postgres.status@1" | "postgres.restart.plan@1" | "postgres.config.inspect@1" | "postgres.config.plan@1" | "postgres.hba.inspect@1" | "postgres.tls.inspect@1" | "postgres.roles.inspect@1" | "postgres.roles.plan@1" | "postgres.extensions.inspect@1" | "system.health@1" | "system.reboot_required@1" | "disk.stats@1" | "memory.stats@1" | "cpu.stats@1" | "service.status@1" | "log.inspect@1" | "wal.status@1" | "wal.archive_status@1" | "packages.audit@1" | "packages.plan_update@1" | "agent.diagnostics@1"

export type Installation = {
  readonly contracts: {
    readonly mcpCatalog: "exponetdb.mcp/v1"
    readonly migrationManifest: "exponetdb.migration/v1"
    readonly nodeProtocol: "exponetdb.node/v1"
    readonly projectConfig: "exponetdb.project/v1"
    readonly restApi: "v1"
  }
  readonly features: readonly string[]
  readonly version: string
}

export type InstallationHealth = {
  readonly components: ReadonlyArray<{
    readonly component: string
    readonly observedAt: string
    readonly source: string
    readonly state: ControlPlaneHealthState
  }>
  readonly state: ControlPlaneHealthState
}

export type Invitation = {
  readonly identity: Identity
  readonly invitation: {
    readonly delivery: InvitationDelivery
    readonly expiresAt: string
    readonly link: string
  }
}

export type InvitationDelivery = {
  readonly channel: "none" | "email"
  readonly status: "not_configured" | "sent" | "failed"
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | ({
  readonly [key: string]: JsonValue
})

export type JwkView = {
  readonly alg: "ES256" | "ES384" | "EdDSA" | "PS256" | "RS256" | null
  readonly kid: string
  readonly kty: "EC" | "OKP" | "RSA"
  readonly thumbprint: string
}

export type LedgerEntry = {
  readonly appliedAt: string
  readonly checksum: string
  readonly migrationId: string
  readonly name: string
  readonly operationId: string | null
  readonly origin: "exponetdb" | "legacy_import" | "baseline"
  readonly reverted: boolean
  readonly verification: {
    readonly status: VerificationStatus
    readonly verifiedAt: string | null
    readonly verifyDigest: string | null
  }
}

export type LintFinding = {
  readonly blocking: boolean
  readonly file: "migration.yaml" | "up.sql" | "verify.sql" | "down.sql" | null
  readonly level: "error" | "warn" | "info"
  readonly message: string
  readonly rule: string
  readonly statementIndex: number | null
}

export type LockGraph = {
  readonly observedAt: string
  readonly source: string
  readonly targetId: string
  readonly truncated: boolean
  readonly waits: ReadonlyArray<{
    readonly blockingPids: readonly number[]
    readonly exponetdbOperationId: string | null
    readonly lockMode: string
    readonly relation: string | null
    readonly waitingPid: number
    readonly waitingSince: string | null
  }>
}

export type MachineGrantRequest = {
  readonly acknowledgeProductionWrite?: true
  readonly lifetimeDays: number
  readonly restrictions: GrantRestrictions
  readonly scopes: ReadonlyArray<"targets.read" | "schema.read" | "diagnostics.read" | "data.read:nonprod" | "data.read:prod" | "migrations.read" | "migrations.plan" | "migrations.apply:nonprod" | "migrations.apply:prod" | "connections.operate:nonprod" | "connections.operate:prod" | "backups.read" | "backups.run" | "restore.plan" | "nodes.read" | "nodes.plan" | "nodes.operate:nonprod" | "nodes.operate:prod" | "audit.read" | "api" | "registry.manage" | "access.read" | "access.manage" | "policy.manage" | "restore.execute" | "plans.approve" | "operations.recover" | "breakglass.activate" | "diagnostics.read_sensitive" | "data.read_sensitive" | "migrations.import" | "schema.manage">
}

export type ManagedScope = {
  readonly excludeSchemas: readonly string[]
  readonly includeSchemas: readonly string[] | null
}

export type ManagedScopeRequest = {
  readonly excludeSchemas?: readonly string[]
  readonly includeSchemas?: readonly string[]
}

export type Me = {
  readonly bindings: readonly RoleBinding[]
  readonly effectivePermissions: readonly EffectivePermission[]
  readonly identity: Identity
  readonly session: WebSession
}

export type MigrationBundleSubmission = {
  readonly directory: string
  readonly files: {
    readonly "down.sql"?: string
    readonly "migration.yaml": string
    readonly "up.sql": string
    readonly "verify.sql"?: string
  }
}

export type MigrationLintRequest = {
  readonly bundles: readonly MigrationBundleSubmission[]
}

export type MigrationLintResult = {
  readonly bundles: ReadonlyArray<{
    readonly bundleDigest: string | null
    readonly checksum: string | null
    readonly directory: string
    readonly findings: readonly LintFinding[]
    readonly migrationId: string | null
    readonly rollbackDigest: string | null
    readonly sourceDigest: string | null
    readonly verifyDigest: string | null
  }>
  readonly graph: {
    readonly errors: ReadonlyArray<{
      readonly code: string
      readonly migrationIds: readonly string[]
    }>
    readonly valid: boolean
  }
}

export type MigrationStatus = {
  readonly applied: readonly LedgerEntry[]
  readonly baselineId: string | null
  readonly ledgerStateHash: string | null
  readonly mirror: {
    readonly checkedAt: string
    readonly inSync: boolean
  }
  readonly observedAt: string
  readonly pending: ReadonlyArray<{
    readonly checksum: string
    readonly migrationId: string
    readonly name: string
  }>
  readonly source: string
  readonly targetId: string
}

export type Node = {
  readonly agentVersion: string | null
  readonly capabilities: readonly CapabilityRef[]
  readonly clockSkewMs: number | null
  readonly id: string
  readonly lastHeartbeatAt: string | null
  readonly protocolMajor: number | null
  readonly serverId: string
  readonly state: NodeHealthState
}

export type NodeChange = ({
  readonly kind: "postgres.reload"
}) | ({
  readonly kind: "postgres.restart"
}) | ({
  readonly changes: ReadonlyArray<{
    readonly name: string
    readonly value: string | null
  }>
  readonly kind: "postgres.config.apply"
  readonly reload: boolean
}) | ({
  readonly kind: "postgres.hba.apply"
  readonly managedRules: ReadonlyArray<{
    readonly address: string | null
    readonly database: readonly string[]
    readonly map: string | null
    readonly method: "scram-sha-256" | "peer" | "reject"
    readonly type: "local" | "hostssl"
    readonly user: readonly string[]
  }>
  readonly protectedAccess: readonly NodeHbaProtectedAccess[]
}) | ({
  readonly kind: "postgres.roles.apply"
  readonly steps: readonly NodeRoleStep[]
}) | ({
  readonly database: string
  readonly kind: "postgres.extensions.apply"
  readonly steps: ReadonlyArray<{
    readonly name: string
    readonly op: "create" | "update"
    readonly schema: string | null
    readonly version: string
  }>
}) | ({
  readonly dnsNames: readonly string[]
  readonly ipAddresses: readonly string[]
  readonly kind: "postgres.tls.rotate"
  readonly validityDays: number
})

export type NodeConfigUpdateRequest = {
  readonly addJobKeys: readonly string[]
  readonly retireJobKeys: readonly string[]
}

export type NodeHbaProtectedAccess = {
  readonly address: string
  readonly database: string
  readonly method: "scram-sha-256" | "peer"
  readonly role: string
}

export type NodeHealthState = "active" | "degraded" | "offline" | "revoked" | "unknown" | "pending_enrollment" | "decommissioned" | "binding_failed"

export type NodeInspectionRequest = {
  readonly args: {
    readonly [key: string]: JsonValue
  }
  readonly capability: InspectableCapability
  readonly clusterId: string | null
}

export type NodeObservation = {
  readonly argsHash: string
  readonly capability: InspectableCapability
  readonly clusterId: string | null
  readonly jobId: string
  readonly observedAt: string
  readonly operationId: string
  readonly result: JsonValue
  readonly source: "agent_reported"
}

export type NodeObservationList = {
  readonly items: readonly NodeObservation[]
}

export type NodePlanRequest = {
  readonly change: NodeChange
  readonly clusterId: string
}

export type NodeRoleAttributes = {
  readonly bypassrls: unknown
  readonly connectionLimit: number | null
  readonly createdb: unknown
  readonly createrole: unknown
  readonly inherit: unknown
  readonly login: unknown
  readonly replication: unknown
}

export type NodeRoleStep = {
  readonly admin: unknown
  readonly attributes: NodeRoleAttributes | null
  readonly database: string | null
  readonly inherit: unknown
  readonly member: string | null
  readonly op: "create_role" | "alter_role" | "set_password" | "clear_password" | "grant_membership" | "revoke_membership" | "set_role_setting" | "reset_role_setting"
  readonly role: string
  readonly set: unknown
  readonly setting: string | null
  readonly value: string | null
  readonly verifier: NodeSealedValue | null
}

export type NodeSealedValue = {
  readonly ns1: {
    readonly ct: string
    readonly enc: string
  }
}

export type NodeStatus = {
  readonly agentVersion: string | null
  readonly capabilities: readonly CapabilityRef[]
  readonly clockSkewMs: number | null
  readonly clusters: ReadonlyArray<{
    readonly clusterId: string | null
    readonly localName: string
    readonly pendingRestart: boolean
    readonly running: boolean
    readonly serverCertificateExpiresAt: string | null
  }>
  readonly host: ({
    readonly diskUsedPercent: number
    readonly loadAverage1m: number
    readonly memoryUsedBytes: number
  }) | null
  readonly id: string
  readonly lastHeartbeatAt: string | null
  readonly nodeCertificateExpiresAt: string | null
  readonly observedAt: string
  readonly protocolMajor: number | null
  readonly serverId: string
  readonly source: string
  readonly state: NodeHealthState
}

export type OAuthClient = {
  readonly applicationType: "web" | "native" | null
  readonly approvedAt: string | null
  readonly approvedBy: string | null
  readonly approvedFingerprint: string | null
  readonly clientId: string
  readonly clientUri: string | null
  readonly createdAt: string
  readonly firstParty: boolean
  readonly grantTypes: readonly string[]
  readonly id: string
  readonly keys: readonly JwkView[]
  readonly kind: "web" | "cli" | "mcp" | "ci"
  readonly metadataExpiresAt: string | null
  readonly metadataFetchedAt: string | null
  readonly metadataFingerprint: string
  readonly name: string
  readonly pendingExpiresAt: string | null
  readonly redirectUris: readonly string[]
  readonly registration: "first_party" | "pre_registered" | "cimd" | "dcr"
  readonly requesterHash: string | null
  readonly serviceAccountId: string | null
  readonly softwareId: string | null
  readonly softwareVersion: string | null
  readonly state: "pending" | "active" | "rejected" | "disabled"
  readonly stateChangedAt: string
  readonly tokenEndpointAuthMethod: "none" | "private_key_jwt"
}

export type OAuthClientSummary = {
  readonly clientId: string
  readonly firstParty: boolean
  readonly id: string
  readonly kind: "web" | "cli" | "mcp" | "ci"
  readonly name: string
  readonly registration: "first_party" | "pre_registered" | "cimd" | "dcr"
  readonly state: "pending" | "active" | "rejected" | "disabled"
}

export type Operation = {
  readonly actor: Actor
  readonly applyOutcome: ApplyOutcome
  readonly approvalUrl: string | null
  readonly createdAt: string
  readonly errorCode: string | null
  readonly id: string
  readonly kind: "installation.get" | "installation.health.get" | "product.list" | "product.get" | "environment.list" | "project.list" | "project.get" | "target.list" | "target.get" | "target.health.get" | "target.finding.list" | "schema.overview.get" | "schema.object.get" | "schema.search" | "schema.fingerprint.get" | "schema.diff" | "query.run" | "query.explain" | "migration.lint" | "migration.status.get" | "session.list" | "lock.list" | "query_stats.list" | "table_stats.list" | "advisor.run" | "server.list" | "server.get" | "cluster.list" | "cluster.get" | "node.list" | "node.get" | "backup.list" | "audit.search" | "plan.get" | "operation.get" | "operation.list" | "drift.check" | "migration.plan" | "migration.rollback.plan" | "migration.bundle.ingest" | "migration.import.analyze" | "migration.baseline.plan" | "ledger.reconcile.plan" | "connections.terminate.plan" | "node.plan" | "restore.plan" | "plan.withdraw" | "approval.approve" | "approval.reject" | "breakglass.activate" | "plan.apply" | "target.register" | "target.suspend" | "target.resume" | "target.decommission" | "target.identity.stamp" | "ledger.initialize" | "credential.rotate" | "migration.apply" | "migration.verify" | "migration.rollback" | "migration.baseline" | "migration.resume" | "migration.rebaseline" | "ledger.reconcile" | "drift.accept" | "operation.force_release" | "connections.cancel" | "connections.terminate" | "postgres.config.apply" | "postgres.reload" | "postgres.restart" | "postgres.tls.rotate" | "postgres.roles.apply" | "postgres.extensions.apply" | "postgres.hba.apply" | "packages.apply_update" | "backup.run" | "backup.verify" | "restore.execute" | "node.enroll" | "node.revoke" | "node.decommission" | "node.enroll.plan" | "node.revoke.plan" | "node.config.update.plan" | "node.decommission.plan" | "credential.rotate.plan" | "node.inspect" | "node.enrollment_token.reveal" | "node.config.update" | "access.role_binding.create" | "access.role_binding.delete" | "access.policy_settings.update" | "auth.login" | "auth.enrollment" | "me.get" | "auth.session.list" | "auth.factor.list" | "auth.logout" | "auth.reauth" | "auth.session.revoke" | "auth.passkey.add" | "auth.passkey.remove" | "auth.password.change" | "auth.totp.replace" | "auth.recovery_codes.regenerate" | "identity.list" | "identity.get" | "role.list" | "role.get" | "role_binding.list" | "policy_settings.get" | "approval.list" | "access.identity.invite" | "access.invitation.reissue" | "access.identity.disable" | "access.identity.enable" | "access.identity.erase" | "access.role_binding.create.plan" | "access.role_binding.delete.plan" | "access.policy_settings.update.plan" | "access.identity.enable.plan" | "access.identity.erase.plan" | "endpoint.list" | "database.list" | "credential.list" | "cluster.bootstrap_sql.get" | "registry.product.create.plan" | "registry.environment.create.plan" | "registry.environment.update.plan" | "registry.project.create.plan" | "registry.project.update.plan" | "registry.server.create.plan" | "registry.cluster.register.plan" | "registry.cluster.confirm.plan" | "registry.endpoint.add.plan" | "registry.endpoint.retire.plan" | "registry.database.register.plan" | "target.register.plan" | "target.suspend.plan" | "target.resume.plan" | "target.decommission.plan" | "registry.product.create" | "registry.environment.create" | "registry.environment.update" | "registry.project.create" | "registry.project.update" | "registry.server.create" | "registry.cluster.register" | "registry.cluster.confirm" | "registry.endpoint.add" | "registry.endpoint.retire" | "registry.database.register" | "registry.credential.submit" | "oauth.metadata.get" | "oauth.authorize" | "oauth.token" | "oauth.revoke" | "oauth.register" | "oauth.device_authorization" | "oauth.consent.get" | "oauth.consent" | "oauth.grant.list_own" | "oauth.grant.revoke_own" | "oauth.client.list" | "oauth.client.get" | "oauth.client.register_cimd" | "oauth.client.refresh_metadata" | "oauth.client.approve" | "oauth.client.reject" | "oauth.client.disable" | "oauth.grant.list" | "oauth.grant.revoke" | "service_account.list" | "service_account.get" | "service_account.create" | "service_account.client.register" | "service_account.client.keys.replace" | "service_account.grant.create" | "api_key.list" | "api_key.create" | "api_key.revoke"
  readonly planId: string | null
  readonly state: OperationState
  readonly steps: ReadonlyArray<{
    readonly finishedAt: string | null
    readonly index: number
    readonly name: string
    readonly startedAt: string | null
    readonly state: "pending" | "running" | "succeeded" | "failed" | "skipped"
  }>
  readonly subject: SubjectRef
  readonly updatedAt: string
  readonly verificationOutcome: VerificationOutcome
  readonly waitingFor: ({
    readonly operationId: string
  }) | null
}

export type OperationState = "awaiting_approval" | "queued" | "running" | "verifying" | "needs_reconciliation" | "needs_attention" | "succeeded" | "failed" | "verification_failed" | "canceled"

export type PlanState = "active" | "consumed" | "expired" | "invalidated" | "denied" | "withdrawn"

export type PlanView = {
  readonly actor: Actor
  readonly approvals: {
    readonly given: number
    readonly required: number
  }
  readonly change?: {
    readonly analysis: JsonValue
    readonly content: JsonValue
  }
  readonly class: "read" | "low" | "standard" | "high" | "critical"
  readonly clientId: string | null
  readonly contentChecksum: string
  readonly createdAt: string
  readonly decision: "allow" | "require" | "deny"
  readonly expiresAt: string
  readonly id: string
  readonly kind: "installation.get" | "installation.health.get" | "product.list" | "product.get" | "environment.list" | "project.list" | "project.get" | "target.list" | "target.get" | "target.health.get" | "target.finding.list" | "schema.overview.get" | "schema.object.get" | "schema.search" | "schema.fingerprint.get" | "schema.diff" | "query.run" | "query.explain" | "migration.lint" | "migration.status.get" | "session.list" | "lock.list" | "query_stats.list" | "table_stats.list" | "advisor.run" | "server.list" | "server.get" | "cluster.list" | "cluster.get" | "node.list" | "node.get" | "backup.list" | "audit.search" | "plan.get" | "operation.get" | "operation.list" | "drift.check" | "migration.plan" | "migration.rollback.plan" | "migration.bundle.ingest" | "migration.import.analyze" | "migration.baseline.plan" | "ledger.reconcile.plan" | "connections.terminate.plan" | "node.plan" | "restore.plan" | "plan.withdraw" | "approval.approve" | "approval.reject" | "breakglass.activate" | "plan.apply" | "target.register" | "target.suspend" | "target.resume" | "target.decommission" | "target.identity.stamp" | "ledger.initialize" | "credential.rotate" | "migration.apply" | "migration.verify" | "migration.rollback" | "migration.baseline" | "migration.resume" | "migration.rebaseline" | "ledger.reconcile" | "drift.accept" | "operation.force_release" | "connections.cancel" | "connections.terminate" | "postgres.config.apply" | "postgres.reload" | "postgres.restart" | "postgres.tls.rotate" | "postgres.roles.apply" | "postgres.extensions.apply" | "postgres.hba.apply" | "packages.apply_update" | "backup.run" | "backup.verify" | "restore.execute" | "node.enroll" | "node.revoke" | "node.decommission" | "node.enroll.plan" | "node.revoke.plan" | "node.config.update.plan" | "node.decommission.plan" | "credential.rotate.plan" | "node.inspect" | "node.enrollment_token.reveal" | "node.config.update" | "access.role_binding.create" | "access.role_binding.delete" | "access.policy_settings.update" | "auth.login" | "auth.enrollment" | "me.get" | "auth.session.list" | "auth.factor.list" | "auth.logout" | "auth.reauth" | "auth.session.revoke" | "auth.passkey.add" | "auth.passkey.remove" | "auth.password.change" | "auth.totp.replace" | "auth.recovery_codes.regenerate" | "identity.list" | "identity.get" | "role.list" | "role.get" | "role_binding.list" | "policy_settings.get" | "approval.list" | "access.identity.invite" | "access.invitation.reissue" | "access.identity.disable" | "access.identity.enable" | "access.identity.erase" | "access.role_binding.create.plan" | "access.role_binding.delete.plan" | "access.policy_settings.update.plan" | "access.identity.enable.plan" | "access.identity.erase.plan" | "endpoint.list" | "database.list" | "credential.list" | "cluster.bootstrap_sql.get" | "registry.product.create.plan" | "registry.environment.create.plan" | "registry.environment.update.plan" | "registry.project.create.plan" | "registry.project.update.plan" | "registry.server.create.plan" | "registry.cluster.register.plan" | "registry.cluster.confirm.plan" | "registry.endpoint.add.plan" | "registry.endpoint.retire.plan" | "registry.database.register.plan" | "target.register.plan" | "target.suspend.plan" | "target.resume.plan" | "target.decommission.plan" | "registry.product.create" | "registry.environment.create" | "registry.environment.update" | "registry.project.create" | "registry.project.update" | "registry.server.create" | "registry.cluster.register" | "registry.cluster.confirm" | "registry.endpoint.add" | "registry.endpoint.retire" | "registry.database.register" | "registry.credential.submit" | "oauth.metadata.get" | "oauth.authorize" | "oauth.token" | "oauth.revoke" | "oauth.register" | "oauth.device_authorization" | "oauth.consent.get" | "oauth.consent" | "oauth.grant.list_own" | "oauth.grant.revoke_own" | "oauth.client.list" | "oauth.client.get" | "oauth.client.register_cimd" | "oauth.client.refresh_metadata" | "oauth.client.approve" | "oauth.client.reject" | "oauth.client.disable" | "oauth.grant.list" | "oauth.grant.revoke" | "service_account.list" | "service_account.get" | "service_account.create" | "service_account.client.register" | "service_account.client.keys.replace" | "service_account.grant.create" | "api_key.list" | "api_key.create" | "api_key.revoke"
  readonly kindVersion: number
  readonly overriddenRules: readonly string[]
  readonly planHash: string
  readonly requirements: readonly PolicyRequirement[]
  readonly state: PlanState
  readonly subject: SubjectRef
}

export type PolicyRequirement = ({
  readonly count: number
  readonly kind: "approval"
  readonly permission: "plans.approve"
}) | ({
  readonly kind: "reauth"
  readonly withinSeconds: number
}) | ({
  readonly kind: "backup"
  readonly newerThan: string
  readonly verified: true
}) | ({
  readonly kind: "maintenance_window"
  readonly windowId: string
}) | ({
  readonly kind: "break_glass"
  readonly rules: readonly string[]
})

export type PolicyRule = {
  readonly appliesTo: readonly string[]
  readonly defaults: {
    readonly [key: string]: JsonValue
  }
  readonly description: string
  readonly id: string
  readonly settings: ReadonlyArray<{
    readonly createdAt: string
    readonly operationId: string | null
    readonly params: {
      readonly [key: string]: JsonValue
    }
    readonly revision: number
    readonly scopeId: string
    readonly scopeKind: "installation" | "product" | "project" | "environment" | "target"
  }>
  readonly severity: "deny" | "require" | "warn"
  readonly version: number
}

export type PolicySettings = {
  readonly rules: readonly PolicyRule[]
}

export type ProbeResult = {
  readonly durationMs: number | null
  readonly endpoint: {
    readonly id: string | null
    readonly kind: "private" | "public" | "local_socket" | "pooler"
    readonly label: string
    readonly verified: boolean
  }
  readonly errorClass: string | null
  readonly observedAt: string
  readonly outcome: "ok" | "failed" | "timeout"
  readonly probe: "simple" | "extended" | "identity" | "activity" | "settings"
  readonly tls: "verified" | "failed" | "not_reached"
}

export type Problem = {
  readonly code: string
  readonly details?: {
    readonly [key: string]: unknown
  }
  readonly message: string
  readonly operationId?: string
  readonly planId?: string
  readonly remediation?: string
  readonly requestId: string
  readonly retryable: boolean
  readonly status: number
  readonly title: string
  readonly type: string
}

export type Product = {
  readonly displayName: string
  readonly id: string
  readonly slug: string
}

export type ProductCreateRequest = {
  readonly displayName: string
  readonly slug: string
}

export type Project = {
  readonly displayName: string
  readonly evidenceOverride: {
    readonly [key: string]: "none"
  }
  readonly id: string
  readonly managedScope: ManagedScope
  readonly path: string
  readonly productId: string
  readonly revision: number
  readonly slug: string
}

export type ProjectChangeRequest = {
  readonly displayName?: string
  readonly evidenceOverride?: {
    readonly [key: string]: "none"
  }
  readonly managedScope?: ManagedScopeRequest
}

export type ProjectCreateRequest = {
  readonly displayName: string
  readonly evidenceOverride?: {
    readonly [key: string]: "none"
  }
  readonly managedScope?: ManagedScopeRequest
  readonly product: string
  readonly slug: string
}

export type PublicJwk = ({
  readonly alg?: "ES256" | "ES384" | "EdDSA" | "PS256" | "RS256"
  readonly crv: "P-256" | "P-384"
  readonly kid: string
  readonly kty: "EC"
  readonly use?: "sig"
  readonly x: string
  readonly y: string
}) | ({
  readonly alg?: "ES256" | "ES384" | "EdDSA" | "PS256" | "RS256"
  readonly crv: "Ed25519"
  readonly kid: string
  readonly kty: "OKP"
  readonly use?: "sig"
  readonly x: string
}) | ({
  readonly alg?: "ES256" | "ES384" | "EdDSA" | "PS256" | "RS256"
  readonly e: string
  readonly kid: string
  readonly kty: "RSA"
  readonly n: string
  readonly use?: "sig"
})

export type PublicJwks = {
  readonly keys: readonly PublicJwk[]
}

export type QueryRequest = {
  readonly maxRows?: number
  readonly params?: readonly unknown[]
  readonly sql: string
}

export type QueryResult = {
  readonly columns: ReadonlyArray<{
    readonly masked: boolean
    readonly name: string
    readonly type: string
  }>
  readonly durationMs: number
  readonly rlsRelations: readonly string[]
  readonly rowCount: number
  readonly rows: ReadonlyArray<readonly JsonValue[]>
  readonly statementDigest: string
  readonly truncated: boolean
  readonly truncation: ({
    readonly cap: number
    readonly reason: "rows" | "bytes"
  }) | null
}

export type QueryStats = {
  readonly observedAt: string
  readonly source: string
  readonly statements: ReadonlyArray<{
    readonly calls: number
    readonly digest: string
    readonly meanTimeMs: number
    readonly normalizedText: string
    readonly rows: number
    readonly sharedBlocksHit: number
    readonly sharedBlocksRead: number
    readonly totalTimeMs: number
  }>
  readonly targetId: string
  readonly truncated: boolean
  readonly window: {
    readonly from: string
    readonly to: string
  }
}

export type RevokeRequest = {
  readonly reason?: string
}

export type RevokeResult = {
  readonly revoked: boolean
}

export type Role = {
  readonly builtIn: true
  readonly id: RoleId
  readonly intendedFor: string
  readonly permissions: ReadonlyArray<"targets.read" | "schema.read" | "schema.manage" | "diagnostics.read" | "diagnostics.read_sensitive" | "data.read" | "data.read_sensitive" | "migrations.read" | "migrations.plan" | "migrations.apply" | "migrations.import" | "connections.operate" | "backups.read" | "backups.run" | "restore.plan" | "restore.execute" | "nodes.read" | "nodes.plan" | "nodes.operate" | "plans.approve" | "operations.recover" | "breakglass.activate" | "audit.read" | "registry.manage" | "access.read" | "access.manage" | "policy.manage">
  readonly title: string
}

export type RoleBinding = {
  readonly createdAt: string
  readonly createdByOperationId: string | null
  readonly id: string
  readonly identityId: string
  readonly revokedAt: string | null
  readonly roleId: RoleId
  readonly scope: BindingScope
  readonly state: "active" | "revoked"
}

export type RoleId = "owner" | "admin" | "operator" | "developer" | "viewer" | "auditor"

export type SchemaDiff = {
  readonly comparable: boolean
  readonly groups: ReadonlyArray<{
    readonly added: readonly SchemaObjectRef[]
    readonly changed: ReadonlyArray<{
      readonly attributes: readonly string[]
      readonly ref: SchemaObjectRef
    }>
    readonly objectClass: string
    readonly removed: readonly SchemaObjectRef[]
  }>
  readonly left: {
    readonly fingerprint: string
  }
  readonly right: {
    readonly fingerprint: string
  }
  readonly securityRelevant: readonly SchemaObjectRef[]
  readonly totals: {
    readonly added: number
    readonly changed: number
    readonly matched: number
    readonly removed: number
    readonly securityRelevant: number
  }
  readonly truncated: boolean
}

export type SchemaDiffRequest = {
  readonly left: SchemaSide
  readonly right: SchemaSide
}

export type SchemaFingerprintResult = {
  readonly canonicalizer: string
  readonly complete: boolean
  readonly documentDigest: string
  readonly entries: number
  readonly fingerprint: string
  readonly observedAt: string
  readonly pgMajor: number
  readonly snapshotId: string
  readonly source: string
  readonly targetId: string
  readonly visibility: VisibilityReport
}

export type SchemaObject = {
  readonly columns: (ReadonlyArray<{
    readonly default: string | null
    readonly generated: string | null
    readonly identity: "always" | "by_default" | null
    readonly name: string
    readonly nullable: boolean
    readonly type: string
  }>) | null
  readonly comment: string | null
  readonly constraints: (ReadonlyArray<{
    readonly definition: string
    readonly name: string
    readonly type: "primary_key" | "foreign_key" | "unique" | "check" | "exclusion" | "not_null"
    readonly validated: boolean
  }>) | null
  readonly definition: string | null
  readonly grants: (ReadonlyArray<{
    readonly grantee: string
    readonly privileges: readonly string[]
  }>) | null
  readonly indexes: (ReadonlyArray<{
    readonly definition: string
    readonly name: string
    readonly unique: boolean
    readonly valid: boolean
  }>) | null
  readonly observedAt: string
  readonly owner: string
  readonly policies: (ReadonlyArray<{
    readonly command: "all" | "select" | "insert" | "update" | "delete"
    readonly name: string
    readonly permissive: boolean
    readonly roles: readonly string[]
    readonly using: string | null
    readonly withCheck: string | null
  }>) | null
  readonly ref: SchemaObjectRef
  readonly rowLevelSecurity: ({
    readonly enabled: boolean
    readonly forced: boolean
  }) | null
  readonly sizeBytes: number | null
  readonly source: string
}

export type SchemaObjectRef = {
  readonly key: readonly string[]
  readonly kind: string
  readonly name: string
  readonly parent: string | null
  readonly schema: string
  readonly signature: string | null
}

export type SchemaOverview = {
  readonly complete: boolean
  readonly fingerprint: string | null
  readonly observedAt: string
  readonly pgMajor: number | null
  readonly schemas: ReadonlyArray<{
    readonly managed: boolean
    readonly name: string
    readonly objectCounts: {
      readonly [key: string]: number
    }
  }>
  readonly source: string
  readonly targetId: string
  readonly visibility: VisibilityReport
}

export type SchemaSide = ({
  readonly target: string
}) | ({
  readonly fingerprint: string
})

export type Server = {
  readonly derivedTier: "prod" | "nonprod" | null
  readonly displayName: string
  readonly id: string
  readonly location: string | null
  readonly observedFacts: ({
    readonly cpus: number
    readonly kernel: string
    readonly memoryBytes: number
    readonly os: string
    readonly reportedAt: string
  }) | null
  readonly provider: "hetzner_cloud" | "hetzner_robot" | "other" | "unknown"
}

export type ServerCreateRequest = {
  readonly displayName: string
  readonly location?: string
  readonly provider: "hetzner_cloud" | "hetzner_robot" | "other" | "unknown"
  readonly providerRef?: string
}

export type ServiceAccount = {
  readonly apiKeys: readonly ApiKey[]
  readonly client: OAuthClient | null
  readonly createdAt: string
  readonly createdBy: string
  readonly displayName: string | null
  readonly grants: readonly Grant[]
  readonly id: string
  readonly label: string
  readonly responsibleIdentityId: string
  readonly state: "invited" | "active" | "disabled" | "erased"
}

export type ServiceAccountCreateRequest = {
  readonly displayName: string
  readonly responsibleIdentityId?: string
}

export type ServiceClientKeysRequest = {
  readonly jwks: PublicJwks
}

export type Session = {
  readonly applicationName: string
  readonly backendStart: string
  readonly exponetdbOperationId: string | null
  readonly pid: number
  readonly queryAgeMs: number | null
  readonly queryStart: string | null
  readonly role: string
  readonly state: string
  readonly stateAgeMs: number | null
  readonly statement: ({
    readonly digest: string | null
    readonly redacted: string
  }) | null
  readonly transactionAgeMs: number | null
  readonly waitEvent: ({
    readonly event: string
    readonly type: string
  }) | null
}

export type SessionList = {
  readonly cap: number
  readonly observedAt: string
  readonly sessions: readonly Session[]
  readonly source: string
  readonly targetId: string
  readonly truncated: boolean
}

export type SessionRevokeResult = {
  readonly revoked: number
}

export type SubjectRef = {
  readonly clusterId: string | null
  readonly nodeId: string | null
  readonly targetId: string | null
  readonly targetPath: string | null
  readonly tier: "prod" | "nonprod" | null
}

export type TableStats = {
  readonly indexes: ReadonlyArray<{
    readonly duplicateOf: string | null
    readonly name: string
    readonly scans: number
    readonly schema: string
    readonly sizeBytes: number
    readonly table: string
    readonly valid: boolean
  }>
  readonly observedAt: string
  readonly source: string
  readonly tables: ReadonlyArray<{
    readonly bloatEstimateBytes: number | null
    readonly deadTuples: number
    readonly indexScans: number
    readonly indexSizeBytes: number
    readonly lastAnalyzeAt: string | null
    readonly lastAutoanalyzeAt: string | null
    readonly lastAutovacuumAt: string | null
    readonly lastVacuumAt: string | null
    readonly liveTuples: number
    readonly name: string
    readonly schema: string
    readonly sequentialScans: number
    readonly sizeBytes: number
    readonly xidAge: number
  }>
  readonly targetId: string
  readonly truncated: boolean
}

export type Target = {
  readonly environment: {
    readonly slug: string
    readonly tier: "prod" | "nonprod"
  }
  readonly environmentId: string
  readonly generation: number
  readonly health: HealthSummary | null
  readonly id: string
  readonly ledger: ({
    readonly appliedCount: number
    readonly lastAppliedAt: string | null
    readonly ledgerStateHash: string | null
    readonly observedAt: string
    readonly source: string
  }) | null
  readonly openFindingCount: number
  readonly path: string
  readonly placement: ({
    readonly clusterId: string
    readonly clusterName: string
    readonly generation: number
    readonly managementMode: "agent" | "external"
    readonly postgresVersion: string | null
    readonly serverName: string | null
    readonly since: string
  }) | null
  readonly productId: string
  readonly projectId: string
  readonly state: TargetState
  readonly tier: "prod" | "nonprod"
}

export type TargetHealth = {
  readonly backups: ({
    readonly observedAt: string
    readonly source: string
    readonly state: BackupHealthState
  }) | null
  readonly conditions: readonly HealthCondition[]
  readonly lifecycle: TargetState
  readonly node: ({
    readonly nodeId: string
    readonly observedAt: string
    readonly source: string
    readonly state: NodeHealthState
  }) | null
  readonly observedAt: string
  readonly probes: readonly ProbeResult[]
  readonly source: string
  readonly state: TargetHealthState
  readonly targetId: string
  readonly unknownBecause: string | null
}

export type TargetHealthState = "healthy" | "degraded" | "unhealthy" | "unreachable" | "unknown" | "suspended"

export type TargetRegisterRequest = {
  readonly databaseId: string
  readonly environmentId: string
  readonly projectId: string
}

export type TargetRestriction = ({
  readonly kind: "all"
}) | ({
  readonly kind: "list"
  readonly targetIds: readonly string[]
})

export type TargetState = "registered" | "active" | "suspended" | "decommissioned"

export type TargetStateChangeRequest = {
  readonly reason: string
}

export type TargetSummary = {
  readonly environmentId: string
  readonly generation: number
  readonly health: HealthSummary | null
  readonly id: string
  readonly path: string
  readonly productId: string
  readonly projectId: string
  readonly state: TargetState
  readonly tier: "prod" | "nonprod"
}

export type VerificationOutcome = "not_applicable" | "pending" | "passed" | "failed" | "partial" | "error"

export type VerificationStatus = "pending" | "passed" | "failed" | "partial" | "error"

export type VisibilityReport = {
  readonly complete: boolean
  readonly gapCount: number
  readonly gaps: ReadonlyArray<{
    readonly attribute: string
    readonly key: readonly string[]
    readonly objectClass: string
    readonly reason: string
  }>
  readonly missingSchemas: readonly string[]
}

export type WebSession = {
  readonly assurance: "full" | "recovery"
  readonly clientKind: "web"
  readonly createdAt: string
  readonly current: boolean
  readonly device: string
  readonly expiresAt: string
  readonly id: string
  readonly idleExpiresAt: string
  readonly lastSeenAt: string
  readonly reauthAt: string | null
}

/** Every `/api/v1` operation: path parameters, query, body and success response. */
export interface Operations {
  applyPlan: {
    readonly params: { readonly planId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: Operation
  }
  approveOAuthClient: {
    readonly params: { readonly oauthClientId: string }
    readonly query: Record<string, never>
    readonly body: ClientApprovalRequest
    readonly response: OAuthClient
  }
  approveOperation: {
    readonly params: { readonly operationId: string }
    readonly query: Record<string, never>
    readonly body: {
      readonly acknowledgeSelfApproval?: true
      readonly planHash: string
    }
    readonly response: Approval
  }
  createApiKey: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: ApiKeyCreateRequest
    readonly response: ApiKeyCreated
  }
  createMachineGrant: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: MachineGrantRequest
    readonly response: Grant
  }
  createSchemaDiff: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: SchemaDiffRequest
    readonly response: SchemaDiff
  }
  createServiceAccount: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: ServiceAccountCreateRequest
    readonly response: ServiceAccount
  }
  disableIdentity: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: {
      readonly reason?: string
    }
    readonly response: Identity
  }
  disableOAuthClient: {
    readonly params: { readonly oauthClientId: string }
    readonly query: Record<string, never>
    readonly body: ClientDecisionReason
    readonly response: OAuthClient
  }
  explainQuery: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: ExplainRequest
    readonly response: ExplainResult
  }
  getCluster: {
    readonly params: { readonly clusterId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Cluster
  }
  getClusterBootstrapSql: {
    readonly params: { readonly clusterId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: ClusterBootstrapSql
  }
  getIdentity: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Identity
  }
  getInstallation: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Installation
  }
  getInstallationHealth: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: never
    readonly response: InstallationHealth
  }
  getLockGraph: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: LockGraph
  }
  getMe: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Me
  }
  getNode: {
    readonly params: { readonly nodeId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: NodeStatus
  }
  getOAuthClient: {
    readonly params: { readonly oauthClientId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: OAuthClient
  }
  getOperation: {
    readonly params: { readonly operationId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Operation
  }
  getPlan: {
    readonly params: { readonly planId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: PlanView
  }
  getPolicySettings: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: never
    readonly response: PolicySettings
  }
  getProduct: {
    readonly params: { readonly productId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Product
  }
  getProject: {
    readonly params: { readonly projectId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Project
  }
  getQueryStats: {
    readonly params: { readonly target: string }
    readonly query: { readonly from?: string; readonly limit?: number; readonly order?: "total_time" | "mean_time" | "calls" | "io"; readonly to?: string }
    readonly body: never
    readonly response: QueryStats
  }
  getRole: {
    readonly params: { readonly roleId: RoleId }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Role
  }
  getSchemaFingerprint: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: SchemaFingerprintResult
  }
  getSchemaObject: {
    readonly params: { readonly kind: string; readonly qualifiedName: string; readonly target: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: SchemaObject
  }
  getSchemaOverview: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: SchemaOverview
  }
  getServer: {
    readonly params: { readonly serverId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Server
  }
  getServiceAccount: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: ServiceAccount
  }
  getTableStats: {
    readonly params: { readonly target: string }
    readonly query: { readonly limit?: number; readonly schema?: string }
    readonly body: never
    readonly response: TableStats
  }
  getTarget: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: Target
  }
  getTargetHealth: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: TargetHealth
  }
  getTargetMigrations: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: MigrationStatus
  }
  inspectNode: {
    readonly params: { readonly nodeId: string }
    readonly query: Record<string, never>
    readonly body: NodeInspectionRequest
    readonly response: Operation
  }
  inviteIdentity: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: {
      readonly displayName?: string
      readonly email: string
    }
    readonly response: Invitation
  }
  lintMigrations: {
    readonly params: { readonly projectId: string }
    readonly query: Record<string, never>
    readonly body: MigrationLintRequest
    readonly response: MigrationLintResult
  }
  listApiKeys: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number; readonly serviceAccount?: string }
    readonly body: never
    readonly response: {
      readonly items: readonly ApiKey[]
      readonly nextCursor: string | null
    }
  }
  listApprovals: {
    readonly params: Record<string, never>
    readonly query: { readonly state?: "pending" }
    readonly body: never
    readonly response: {
      readonly items: readonly ApprovalQueueItem[]
    }
  }
  listClusterBackups: {
    readonly params: { readonly clusterId: string }
    readonly query: { readonly limit?: number }
    readonly body: never
    readonly response: BackupCatalog
  }
  listClusterCredentials: {
    readonly params: { readonly clusterId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: {
      readonly items: readonly CredentialView[]
      readonly truncated: boolean
    }
  }
  listClusterDatabases: {
    readonly params: { readonly clusterId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: {
      readonly items: readonly DatabaseView[]
      readonly truncated: boolean
    }
  }
  listClusterEndpoints: {
    readonly params: { readonly clusterId: string }
    readonly query: { readonly state?: "active" | "retired" }
    readonly body: never
    readonly response: {
      readonly items: readonly EndpointView[]
      readonly truncated: boolean
    }
  }
  listClusters: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number }
    readonly body: never
    readonly response: {
      readonly items: readonly Cluster[]
      readonly nextCursor: string | null
    }
  }
  listGrants: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly identity?: string; readonly limit?: number; readonly state?: GrantState }
    readonly body: never
    readonly response: {
      readonly items: readonly Grant[]
      readonly nextCursor: string | null
    }
  }
  listIdentities: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number; readonly state?: IdentityState }
    readonly body: never
    readonly response: {
      readonly items: readonly Identity[]
      readonly nextCursor: string | null
    }
  }
  listMyFactors: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: never
    readonly response: {
      readonly items: readonly AuthFactor[]
    }
  }
  listMyGrants: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: never
    readonly response: {
      readonly items: readonly Grant[]
    }
  }
  listMySessions: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: never
    readonly response: {
      readonly items: readonly WebSession[]
    }
  }
  listNodeObservations: {
    readonly params: { readonly nodeId: string }
    readonly query: { readonly capability?: InspectableCapability; readonly clusterId?: string }
    readonly body: never
    readonly response: NodeObservationList
  }
  listNodes: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number }
    readonly body: never
    readonly response: {
      readonly items: readonly Node[]
      readonly nextCursor: string | null
    }
  }
  listOAuthClients: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number; readonly state?: "pending" | "active" | "rejected" | "disabled" }
    readonly body: never
    readonly response: {
      readonly items: readonly OAuthClient[]
      readonly nextCursor: string | null
    }
  }
  listOperations: {
    readonly params: Record<string, never>
    readonly query: { readonly actor?: "self" | "any"; readonly cursor?: string; readonly kind?: string; readonly limit?: number; readonly state?: OperationState; readonly target?: string }
    readonly body: never
    readonly response: {
      readonly items: readonly Operation[]
      readonly nextCursor: string | null
    }
  }
  listProductEnvironments: {
    readonly params: { readonly productId: string }
    readonly query: { readonly cursor?: string; readonly limit?: number }
    readonly body: never
    readonly response: {
      readonly items: readonly Environment[]
      readonly nextCursor: string | null
    }
  }
  listProducts: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number }
    readonly body: never
    readonly response: {
      readonly items: readonly Product[]
      readonly nextCursor: string | null
    }
  }
  listProjects: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number; readonly product?: string }
    readonly body: never
    readonly response: {
      readonly items: readonly Project[]
      readonly nextCursor: string | null
    }
  }
  listRoleBindings: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly identity?: string; readonly limit?: number; readonly state?: "active" | "revoked" }
    readonly body: never
    readonly response: {
      readonly items: readonly RoleBinding[]
      readonly nextCursor: string | null
    }
  }
  listRoles: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: never
    readonly response: {
      readonly items: readonly Role[]
    }
  }
  listServers: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number }
    readonly body: never
    readonly response: {
      readonly items: readonly Server[]
      readonly nextCursor: string | null
    }
  }
  listServiceAccounts: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly limit?: number }
    readonly body: never
    readonly response: {
      readonly items: readonly ServiceAccount[]
      readonly nextCursor: string | null
    }
  }
  listSessions: {
    readonly params: { readonly target: string }
    readonly query: { readonly application?: string; readonly limit?: number; readonly minAgeSeconds?: number; readonly state?: string }
    readonly body: never
    readonly response: SessionList
  }
  listTargetFindings: {
    readonly params: { readonly target: string }
    readonly query: { readonly cursor?: string; readonly includeResolved?: boolean; readonly kind?: "drift" | "health"; readonly limit?: number; readonly severity?: "info" | "warning" | "critical" }
    readonly body: never
    readonly response: {
      readonly items: readonly Finding[]
      readonly nextCursor: string | null
    }
  }
  listTargets: {
    readonly params: Record<string, never>
    readonly query: { readonly cursor?: string; readonly environment?: string; readonly limit?: number; readonly product?: string; readonly project?: string; readonly state?: TargetState; readonly tier?: "prod" | "nonprod" }
    readonly body: never
    readonly response: {
      readonly items: readonly TargetSummary[]
      readonly nextCursor: string | null
    }
  }
  planClusterConfirmation: {
    readonly params: { readonly clusterId: string }
    readonly query: Record<string, never>
    readonly body: ClusterConfirmRequest
    readonly response: PlanView
  }
  planClusterRegistration: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: ClusterRegisterRequest
    readonly response: PlanView
  }
  planCredentialRotation: {
    readonly params: { readonly clusterId: string; readonly role: AccessRole }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: PlanView
  }
  planDatabaseRegistration: {
    readonly params: { readonly clusterId: string }
    readonly query: Record<string, never>
    readonly body: DatabaseRegisterRequest
    readonly response: PlanView
  }
  planEndpoint: {
    readonly params: { readonly clusterId: string }
    readonly query: Record<string, never>
    readonly body: EndpointRequest
    readonly response: PlanView
  }
  planEndpointRetirement: {
    readonly params: { readonly clusterId: string; readonly endpointId: string }
    readonly query: Record<string, never>
    readonly body: EndpointRetireRequest
    readonly response: PlanView
  }
  planEnvironment: {
    readonly params: { readonly productId: string }
    readonly query: Record<string, never>
    readonly body: EnvironmentCreateRequest
    readonly response: PlanView
  }
  planEnvironmentChange: {
    readonly params: { readonly environmentId: string; readonly productId: string }
    readonly query: Record<string, never>
    readonly body: EnvironmentChangeRequest
    readonly response: PlanView
  }
  planIdentityEnable: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: PlanView
  }
  planIdentityErasure: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: PlanView
  }
  planNodeConfigUpdate: {
    readonly params: { readonly nodeId: string }
    readonly query: Record<string, never>
    readonly body: NodeConfigUpdateRequest
    readonly response: PlanView
  }
  planNodeDecommissioning: {
    readonly params: { readonly nodeId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: PlanView
  }
  planNodeEnrollment: {
    readonly params: { readonly serverId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: PlanView
  }
  planNodeOperation: {
    readonly params: { readonly nodeId: string }
    readonly query: Record<string, never>
    readonly body: NodePlanRequest
    readonly response: PlanView
  }
  planNodeRevocation: {
    readonly params: { readonly nodeId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: PlanView
  }
  planPolicySettings: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: {
      readonly params: {
        readonly [key: string]: JsonValue
      }
      readonly ruleId: string
      readonly scopeId: string
      readonly scopeKind: "installation" | "product" | "project" | "environment" | "target"
    }
    readonly response: PlanView
  }
  planProduct: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: ProductCreateRequest
    readonly response: PlanView
  }
  planProject: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: ProjectCreateRequest
    readonly response: PlanView
  }
  planProjectChange: {
    readonly params: { readonly projectId: string }
    readonly query: Record<string, never>
    readonly body: ProjectChangeRequest
    readonly response: PlanView
  }
  planRoleBinding: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: {
      readonly identityId: string
      readonly roleId: RoleId
      readonly scope: BindingScope
    }
    readonly response: PlanView
  }
  planRoleBindingRemoval: {
    readonly params: { readonly bindingId: string }
    readonly query: Record<string, never>
    readonly body: never
    readonly response: PlanView
  }
  planServer: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: ServerCreateRequest
    readonly response: PlanView
  }
  planTargetDecommission: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: TargetStateChangeRequest
    readonly response: PlanView
  }
  planTargetRegistration: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: TargetRegisterRequest
    readonly response: PlanView
  }
  planTargetResumption: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: TargetStateChangeRequest
    readonly response: PlanView
  }
  planTargetSuspension: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: TargetStateChangeRequest
    readonly response: PlanView
  }
  refreshOAuthClientMetadata: {
    readonly params: { readonly oauthClientId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: OAuthClient
  }
  registerCimdClient: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: CimdClientRequest
    readonly response: OAuthClient
  }
  registerServiceAccountClient: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: ServiceClientKeysRequest
    readonly response: OAuthClient
  }
  reissueInvitation: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: Invitation
  }
  rejectOAuthClient: {
    readonly params: { readonly oauthClientId: string }
    readonly query: Record<string, never>
    readonly body: ClientDecisionReason
    readonly response: OAuthClient
  }
  rejectOperation: {
    readonly params: { readonly operationId: string }
    readonly query: Record<string, never>
    readonly body: {
      readonly acknowledgeSelfApproval?: true
      readonly planHash: string
    }
    readonly response: Approval
  }
  replaceServiceAccountClientKeys: {
    readonly params: { readonly identityId: string }
    readonly query: Record<string, never>
    readonly body: ServiceClientKeysRequest
    readonly response: OAuthClient
  }
  revealEnrollmentToken: {
    readonly params: { readonly tokenId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: EnrollmentTokenReveal
  }
  revokeApiKey: {
    readonly params: { readonly keyId: string }
    readonly query: Record<string, never>
    readonly body: RevokeRequest
    readonly response: RevokeResult
  }
  revokeGrant: {
    readonly params: { readonly grantId: string }
    readonly query: Record<string, never>
    readonly body: RevokeRequest
    readonly response: RevokeResult
  }
  revokeMyGrant: {
    readonly params: { readonly grantId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: RevokeResult
  }
  revokeMyOtherSessions: {
    readonly params: Record<string, never>
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: SessionRevokeResult
  }
  revokeMySession: {
    readonly params: { readonly sessionId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: SessionRevokeResult
  }
  runAdvisors: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: AdvisorRunRequest
    readonly response: AdvisorRun
  }
  runDriftCheck: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: DriftCheck
  }
  runQuery: {
    readonly params: { readonly target: string }
    readonly query: Record<string, never>
    readonly body: QueryRequest
    readonly response: QueryResult
  }
  searchAuditEvents: {
    readonly params: Record<string, never>
    readonly query: { readonly action?: string; readonly actor?: "self" | "any"; readonly cursor?: string; readonly from?: string; readonly limit?: number; readonly result?: "succeeded" | "failed" | "denied"; readonly target?: string; readonly to?: string }
    readonly body: never
    readonly response: {
      readonly items: readonly AuditEvent[]
      readonly nextCursor: string | null
    }
  }
  searchSchema: {
    readonly params: { readonly target: string }
    readonly query: { readonly cursor?: string; readonly kinds?: readonly string[]; readonly limit?: number; readonly q: string }
    readonly body: never
    readonly response: {
      readonly items: readonly SchemaObjectRef[]
      readonly nextCursor: string | null
    }
  }
  submitClusterCredential: {
    readonly params: { readonly clusterId: string; readonly role: AccessRole }
    readonly query: Record<string, never>
    readonly body: CredentialSubmission
    readonly response: CredentialView
  }
  withdrawPlan: {
    readonly params: { readonly planId: string }
    readonly query: Record<string, never>
    readonly body: Record<string, never>
    readonly response: PlanView
  }
}

/** The operations at runtime: method, path template, success status, wave, action and body shape. */
export const OPERATIONS = {
  applyPlan: { method: "POST", path: "/plans/{planId}/apply", status: 202, wave: "2", action: "plan.apply", shape: "object" },
  approveOAuthClient: { method: "POST", path: "/oauth-clients/{oauthClientId}/approve", status: 200, wave: "3B", action: "oauth.client.approve", shape: "object" },
  approveOperation: { method: "POST", path: "/approvals/{operationId}/approve", status: 200, wave: "3A", action: "approval.approve", shape: "object" },
  createApiKey: { method: "POST", path: "/service-accounts/{identityId}/api-keys", status: 201, wave: "3B", action: "api_key.create", shape: "object" },
  createMachineGrant: { method: "POST", path: "/service-accounts/{identityId}/grants", status: 201, wave: "3B", action: "service_account.grant.create", shape: "object" },
  createSchemaDiff: { method: "POST", path: "/schema-diffs", status: 200, wave: "4", action: "schema.diff", shape: "object" },
  createServiceAccount: { method: "POST", path: "/service-accounts", status: 201, wave: "3B", action: "service_account.create", shape: "object" },
  disableIdentity: { method: "POST", path: "/identities/{identityId}/disable", status: 200, wave: "3A", action: "access.identity.disable", shape: "object" },
  disableOAuthClient: { method: "POST", path: "/oauth-clients/{oauthClientId}/disable", status: 200, wave: "3B", action: "oauth.client.disable", shape: "object" },
  explainQuery: { method: "POST", path: "/targets/{target}/explain", status: 200, wave: "7", action: "query.explain", shape: "object" },
  getCluster: { method: "GET", path: "/clusters/{clusterId}", status: 200, wave: "4", action: "cluster.get", shape: "object" },
  getClusterBootstrapSql: { method: "GET", path: "/clusters/{clusterId}/bootstrap-sql", status: 200, wave: "4", action: "cluster.bootstrap_sql.get", shape: "object" },
  getIdentity: { method: "GET", path: "/identities/{identityId}", status: 200, wave: "3A", action: "identity.get", shape: "object" },
  getInstallation: { method: "GET", path: "/installation", status: 200, wave: "2", action: "installation.get", shape: "object" },
  getInstallationHealth: { method: "GET", path: "/installation/health", status: 200, wave: "2", action: "installation.health.get", shape: "object" },
  getLockGraph: { method: "GET", path: "/targets/{target}/locks", status: 200, wave: "4", action: "lock.list", shape: "object" },
  getMe: { method: "GET", path: "/me", status: 200, wave: "3A", action: "me.get", shape: "object" },
  getNode: { method: "GET", path: "/nodes/{nodeId}", status: 200, wave: "5", action: "node.get", shape: "object" },
  getOAuthClient: { method: "GET", path: "/oauth-clients/{oauthClientId}", status: 200, wave: "3B", action: "oauth.client.get", shape: "object" },
  getOperation: { method: "GET", path: "/operations/{operationId}", status: 200, wave: "2", action: "operation.get", shape: "object" },
  getPlan: { method: "GET", path: "/plans/{planId}", status: 200, wave: "2", action: "plan.get", shape: "object" },
  getPolicySettings: { method: "GET", path: "/policy-settings", status: 200, wave: "3A", action: "policy_settings.get", shape: "object" },
  getProduct: { method: "GET", path: "/products/{productId}", status: 200, wave: "4", action: "product.get", shape: "object" },
  getProject: { method: "GET", path: "/projects/{projectId}", status: 200, wave: "4", action: "project.get", shape: "object" },
  getQueryStats: { method: "GET", path: "/targets/{target}/query-stats", status: 200, wave: "9", action: "query_stats.list", shape: "object" },
  getRole: { method: "GET", path: "/roles/{roleId}", status: 200, wave: "3A", action: "role.get", shape: "object" },
  getSchemaFingerprint: { method: "GET", path: "/targets/{target}/schema/fingerprint", status: 200, wave: "4", action: "schema.fingerprint.get", shape: "object" },
  getSchemaObject: { method: "GET", path: "/targets/{target}/schema/objects/{kind}/{qualifiedName}", status: 200, wave: "4", action: "schema.object.get", shape: "object" },
  getSchemaOverview: { method: "GET", path: "/targets/{target}/schema", status: 200, wave: "4", action: "schema.overview.get", shape: "object" },
  getServer: { method: "GET", path: "/servers/{serverId}", status: 200, wave: "4", action: "server.get", shape: "object" },
  getServiceAccount: { method: "GET", path: "/service-accounts/{identityId}", status: 200, wave: "3B", action: "service_account.get", shape: "object" },
  getTableStats: { method: "GET", path: "/targets/{target}/table-stats", status: 200, wave: "9", action: "table_stats.list", shape: "object" },
  getTarget: { method: "GET", path: "/targets/{target}", status: 200, wave: "4", action: "target.get", shape: "object" },
  getTargetHealth: { method: "GET", path: "/targets/{target}/health", status: 200, wave: "4", action: "target.health.get", shape: "object" },
  getTargetMigrations: { method: "GET", path: "/targets/{target}/migrations", status: 200, wave: "6", action: "migration.status.get", shape: "object" },
  inspectNode: { method: "POST", path: "/nodes/{nodeId}/inspections", status: 202, wave: "5", action: "node.inspect", shape: "object" },
  inviteIdentity: { method: "POST", path: "/identities", status: 201, wave: "3A", action: "access.identity.invite", shape: "object" },
  lintMigrations: { method: "POST", path: "/projects/{projectId}/migrations/lint", status: 200, wave: "6", action: "migration.lint", shape: "object" },
  listApiKeys: { method: "GET", path: "/api-keys", status: 200, wave: "3B", action: "api_key.list", shape: "paged" },
  listApprovals: { method: "GET", path: "/approvals", status: 200, wave: "3A", action: "approval.list", shape: "object" },
  listClusterBackups: { method: "GET", path: "/clusters/{clusterId}/backups", status: 200, wave: "9", action: "backup.list", shape: "object" },
  listClusterCredentials: { method: "GET", path: "/clusters/{clusterId}/credentials", status: 200, wave: "4", action: "credential.list", shape: "object" },
  listClusterDatabases: { method: "GET", path: "/clusters/{clusterId}/databases", status: 200, wave: "4", action: "database.list", shape: "object" },
  listClusterEndpoints: { method: "GET", path: "/clusters/{clusterId}/endpoints", status: 200, wave: "4", action: "endpoint.list", shape: "object" },
  listClusters: { method: "GET", path: "/clusters", status: 200, wave: "4", action: "cluster.list", shape: "paged" },
  listGrants: { method: "GET", path: "/grants", status: 200, wave: "3B", action: "oauth.grant.list", shape: "paged" },
  listIdentities: { method: "GET", path: "/identities", status: 200, wave: "3A", action: "identity.list", shape: "paged" },
  listMyFactors: { method: "GET", path: "/me/factors", status: 200, wave: "3A", action: "auth.factor.list", shape: "object" },
  listMyGrants: { method: "GET", path: "/me/grants", status: 200, wave: "3B", action: "oauth.grant.list_own", shape: "object" },
  listMySessions: { method: "GET", path: "/me/sessions", status: 200, wave: "3A", action: "auth.session.list", shape: "object" },
  listNodeObservations: { method: "GET", path: "/nodes/{nodeId}/observations", status: 200, wave: "5", action: "node.get", shape: "object" },
  listNodes: { method: "GET", path: "/nodes", status: 200, wave: "5", action: "node.list", shape: "paged" },
  listOAuthClients: { method: "GET", path: "/oauth-clients", status: 200, wave: "3B", action: "oauth.client.list", shape: "paged" },
  listOperations: { method: "GET", path: "/operations", status: 200, wave: "2", action: "operation.list", shape: "paged" },
  listProductEnvironments: { method: "GET", path: "/products/{productId}/environments", status: 200, wave: "4", action: "environment.list", shape: "paged" },
  listProducts: { method: "GET", path: "/products", status: 200, wave: "4", action: "product.list", shape: "paged" },
  listProjects: { method: "GET", path: "/projects", status: 200, wave: "4", action: "project.list", shape: "paged" },
  listRoleBindings: { method: "GET", path: "/role-bindings", status: 200, wave: "3A", action: "role_binding.list", shape: "paged" },
  listRoles: { method: "GET", path: "/roles", status: 200, wave: "3A", action: "role.list", shape: "object" },
  listServers: { method: "GET", path: "/servers", status: 200, wave: "4", action: "server.list", shape: "paged" },
  listServiceAccounts: { method: "GET", path: "/service-accounts", status: 200, wave: "3B", action: "service_account.list", shape: "paged" },
  listSessions: { method: "GET", path: "/targets/{target}/sessions", status: 200, wave: "4", action: "session.list", shape: "object" },
  listTargetFindings: { method: "GET", path: "/targets/{target}/findings", status: 200, wave: "4", action: "target.finding.list", shape: "paged" },
  listTargets: { method: "GET", path: "/targets", status: 200, wave: "4", action: "target.list", shape: "paged" },
  planClusterConfirmation: { method: "POST", path: "/clusters/{clusterId}/confirm", status: 201, wave: "4", action: "registry.cluster.confirm.plan", shape: "object" },
  planClusterRegistration: { method: "POST", path: "/clusters", status: 201, wave: "4", action: "registry.cluster.register.plan", shape: "object" },
  planCredentialRotation: { method: "POST", path: "/clusters/{clusterId}/credentials/{role}/rotate", status: 201, wave: "5", action: "credential.rotate.plan", shape: "object" },
  planDatabaseRegistration: { method: "POST", path: "/clusters/{clusterId}/databases", status: 201, wave: "4", action: "registry.database.register.plan", shape: "object" },
  planEndpoint: { method: "POST", path: "/clusters/{clusterId}/endpoints", status: 201, wave: "4", action: "registry.endpoint.add.plan", shape: "object" },
  planEndpointRetirement: { method: "POST", path: "/clusters/{clusterId}/endpoints/{endpointId}/retire", status: 201, wave: "4", action: "registry.endpoint.retire.plan", shape: "object" },
  planEnvironment: { method: "POST", path: "/products/{productId}/environments", status: 201, wave: "4", action: "registry.environment.create.plan", shape: "object" },
  planEnvironmentChange: { method: "POST", path: "/products/{productId}/environments/{environmentId}/change-plans", status: 201, wave: "4", action: "registry.environment.update.plan", shape: "object" },
  planIdentityEnable: { method: "POST", path: "/identities/{identityId}/enable-plans", status: 201, wave: "3A", action: "access.identity.enable.plan", shape: "object" },
  planIdentityErasure: { method: "POST", path: "/identities/{identityId}/erasure-plans", status: 201, wave: "3A", action: "access.identity.erase.plan", shape: "object" },
  planNodeConfigUpdate: { method: "POST", path: "/nodes/{nodeId}/config-updates", status: 201, wave: "5", action: "node.config.update.plan", shape: "object" },
  planNodeDecommissioning: { method: "POST", path: "/nodes/{nodeId}/decommission", status: 201, wave: "5", action: "node.decommission.plan", shape: "object" },
  planNodeEnrollment: { method: "POST", path: "/servers/{serverId}/nodes/enroll", status: 201, wave: "5", action: "node.enroll.plan", shape: "object" },
  planNodeOperation: { method: "POST", path: "/nodes/{nodeId}/plans", status: 201, wave: "5", action: "node.plan", shape: "object" },
  planNodeRevocation: { method: "POST", path: "/nodes/{nodeId}/revoke", status: 201, wave: "5", action: "node.revoke.plan", shape: "object" },
  planPolicySettings: { method: "POST", path: "/policy-settings/plans", status: 201, wave: "3A", action: "access.policy_settings.update.plan", shape: "object" },
  planProduct: { method: "POST", path: "/products", status: 201, wave: "4", action: "registry.product.create.plan", shape: "object" },
  planProject: { method: "POST", path: "/projects", status: 201, wave: "4", action: "registry.project.create.plan", shape: "object" },
  planProjectChange: { method: "POST", path: "/projects/{projectId}/change-plans", status: 201, wave: "4", action: "registry.project.update.plan", shape: "object" },
  planRoleBinding: { method: "POST", path: "/role-bindings", status: 201, wave: "3A", action: "access.role_binding.create.plan", shape: "object" },
  planRoleBindingRemoval: { method: "DELETE", path: "/role-bindings/{bindingId}", status: 201, wave: "3A", action: "access.role_binding.delete.plan", shape: "object" },
  planServer: { method: "POST", path: "/servers", status: 201, wave: "4", action: "registry.server.create.plan", shape: "object" },
  planTargetDecommission: { method: "POST", path: "/targets/{target}/decommission", status: 201, wave: "4", action: "target.decommission.plan", shape: "object" },
  planTargetRegistration: { method: "POST", path: "/targets", status: 201, wave: "4", action: "target.register.plan", shape: "object" },
  planTargetResumption: { method: "POST", path: "/targets/{target}/resume", status: 201, wave: "4", action: "target.resume.plan", shape: "object" },
  planTargetSuspension: { method: "POST", path: "/targets/{target}/suspend", status: 201, wave: "4", action: "target.suspend.plan", shape: "object" },
  refreshOAuthClientMetadata: { method: "POST", path: "/oauth-clients/{oauthClientId}/refresh-metadata", status: 200, wave: "3B", action: "oauth.client.refresh_metadata", shape: "object" },
  registerCimdClient: { method: "POST", path: "/oauth-clients/cimd", status: 201, wave: "3B", action: "oauth.client.register_cimd", shape: "object" },
  registerServiceAccountClient: { method: "POST", path: "/service-accounts/{identityId}/oauth-client", status: 201, wave: "3B", action: "service_account.client.register", shape: "object" },
  reissueInvitation: { method: "POST", path: "/identities/{identityId}/invitation", status: 200, wave: "3A", action: "access.invitation.reissue", shape: "object" },
  rejectOAuthClient: { method: "POST", path: "/oauth-clients/{oauthClientId}/reject", status: 200, wave: "3B", action: "oauth.client.reject", shape: "object" },
  rejectOperation: { method: "POST", path: "/approvals/{operationId}/reject", status: 200, wave: "3A", action: "approval.reject", shape: "object" },
  replaceServiceAccountClientKeys: { method: "POST", path: "/service-accounts/{identityId}/oauth-client/keys", status: 200, wave: "3B", action: "service_account.client.keys.replace", shape: "object" },
  revealEnrollmentToken: { method: "POST", path: "/enrollment-tokens/{tokenId}/reveal", status: 200, wave: "5", action: "node.enrollment_token.reveal", shape: "object" },
  revokeApiKey: { method: "POST", path: "/api-keys/{keyId}/revoke", status: 200, wave: "3B", action: "api_key.revoke", shape: "object" },
  revokeGrant: { method: "POST", path: "/grants/{grantId}/revoke", status: 200, wave: "3B", action: "oauth.grant.revoke", shape: "object" },
  revokeMyGrant: { method: "POST", path: "/me/grants/{grantId}/revoke", status: 200, wave: "3B", action: "oauth.grant.revoke_own", shape: "object" },
  revokeMyOtherSessions: { method: "POST", path: "/me/sessions/revoke-others", status: 200, wave: "3A", action: "auth.session.revoke", shape: "object" },
  revokeMySession: { method: "POST", path: "/me/sessions/{sessionId}/revoke", status: 200, wave: "3A", action: "auth.session.revoke", shape: "object" },
  runAdvisors: { method: "POST", path: "/targets/{target}/advisor-runs", status: 200, wave: "9", action: "advisor.run", shape: "object" },
  runDriftCheck: { method: "POST", path: "/targets/{target}/drift-checks", status: 201, wave: "4", action: "drift.check", shape: "object" },
  runQuery: { method: "POST", path: "/targets/{target}/queries", status: 200, wave: "7", action: "query.run", shape: "object" },
  searchAuditEvents: { method: "GET", path: "/audit-events", status: 200, wave: "2", action: "audit.search", shape: "paged" },
  searchSchema: { method: "GET", path: "/targets/{target}/schema/search", status: 200, wave: "4", action: "schema.search", shape: "paged" },
  submitClusterCredential: { method: "POST", path: "/clusters/{clusterId}/credentials/{role}", status: 202, wave: "4", action: "registry.credential.submit", shape: "object" },
  withdrawPlan: { method: "POST", path: "/plans/{planId}/withdraw", status: 200, wave: "2", action: "plan.withdraw", shape: "object" },
} as const

export type OperationId = keyof Operations
