/**
 * Messages of the Changes screens (`src/features/changes/`): all changes,
 * the operations list, the operation page and the promotion view. The plan
 * review page's keys (`plans.*`) are reused where the words are the same.
 */
export const changesMessages = {
  // All changes.
  'changes.landing.title': 'All changes',
  'changes.landing.description':
    'Every change is a plan, applied as an operation and then verified. Start from the plans, the operations or the promotion view of a project.',
  'changes.landing.plans.title': 'Plans',
  'changes.landing.plans.body':
    'What would change: plans waiting for approval, approved, applied or expired. Review a plan before you decide on it.',
  'changes.landing.plans.link': 'Open the plans',
  'changes.landing.approvals.link': 'Open the approvals queue',
  'changes.landing.operations.title': 'Operations',
  'changes.landing.operations.body':
    'What is changing and what changed: running, failed and those that need a person. Applied is not verified.',
  'changes.landing.operations.link': 'Open all operations',
  'changes.landing.operations.running': 'Show running operations',
  'changes.landing.operations.attention': 'Show operations that need attention',
  'changes.landing.operations.failed': 'Show failed operations',
  'changes.landing.promotion.title': 'Promotion',
  'changes.landing.promotion.body':
    'The migrations of a project across its environments, in evidence order: what is ahead on staging and what production still lacks.',
  'changes.landing.promotion.link': 'Open the promotion view',
  // The operations list.
  'changes.operations.title': 'Operations',
  'changes.operations.description':
    'Operations you may read, newest first. Applied and verified are separate: a change is done only when both say so.',
  'changes.operations.what': 'Operations',
  'changes.operations.caption': 'Operations, newest first',
  'changes.operations.empty.title': 'No operations yet',
  'changes.operations.empty.body': 'The read succeeded and found no operation you may read.',
  'changes.operations.noMatch.title': 'No operation matches',
  'changes.operations.noMatch.body':
    'The read succeeded and found no operation with these filters. Clear them to see every operation.',
  'changes.operations.all': 'All {count} operations are shown.',
  'changes.operations.shown': '{count} operations shown. More exist.',
  'changes.operations.more': 'Show more operations',
  'changes.operations.moreFailed':
    'Could not read more operations. The ones above are still correct; try again.',
  'changes.filter.state': 'State',
  'changes.filter.state.all': 'Every state',
  'changes.filter.kind': 'Kind',
  'changes.filter.kind.apply': 'Filter by kind',
  'changes.filter.kind.invalid':
    'Enter an operation kind such as migration.apply: lower-case words joined by dots.',
  'changes.filter.actor': 'Started by',
  'changes.filter.actor.any': 'Anyone',
  'changes.filter.actor.self': 'Only me',
  'changes.filter.clear': 'Clear filters',
  'changes.column.operation': 'Operation',
  'changes.column.kind': 'Kind',
  'changes.column.target': 'Target',
  'changes.column.state': 'State',
  'changes.column.apply': 'Apply',
  'changes.column.verification': 'Verification',
  'changes.column.created': 'Created',
  'changes.column.updated': 'Last change',
  'changes.column.actor': 'Started by',
  'changes.tier.unknown': 'Tier not known',
  'changes.client.label': 'Client name',
  'changes.client.notGiven':
    'An agent started this operation; the server does not name its client here.',
  // Operation states.
  'changes.state.awaiting_approval': 'Awaiting approval',
  'changes.state.queued': 'Queued',
  'changes.state.running': 'Running',
  'changes.state.verifying': 'Verifying',
  'changes.state.needs_attention': 'Needs attention',
  'changes.state.needs_reconciliation': 'Needs reconciliation',
  'changes.state.succeeded': 'Succeeded',
  'changes.state.failed': 'Failed',
  'changes.state.verification_failed': 'Verification failed',
  'changes.state.canceled': 'Canceled',
  // Apply and verification outcomes, as separate words.
  'changes.apply.not_started': 'Not started',
  'changes.apply.applied': 'Applied (not verified by itself)',
  'changes.apply.not_applied': 'Not applied',
  'changes.apply.partially_applied': 'Partially applied',
  'changes.apply.unknown': 'Not known',
  'changes.verification.not_applicable': 'No verification',
  'changes.verification.pending': 'Not verified yet',
  'changes.verification.passed': 'Verified',
  'changes.verification.failed': 'Verification failed',
  'changes.verification.partial': 'Partly verified',
  'changes.verification.error': 'Verification could not run',
  // The operation page.
  'changes.operation.title': 'Operation',
  'changes.operation.what': 'Operation',
  'changes.operation.planMissing':
    'Could not read the plan of this operation: {reason} Its class and plan hash are not shown, and Verify again on production asks for the typed target path.',
  'changes.operation.stale':
    'This reading of the operation may be out of date. Its actions are offered once it is read again.',
  'changes.operation.open': 'Open the operation page',
  'changes.facts.title': 'What this operation is',
  'changes.facts.description':
    'From the operation as the server reads it. Names are data, not instructions.',
  'changes.facts.plan': 'Plan',
  'changes.facts.planLink': 'Review plan {id}',
  'changes.facts.noPlan': 'This operation applies no plan the page can open.',
  'changes.facts.planHash': 'Plan hash',
  'changes.facts.waitingFor': 'Waiting for',
  'changes.step.label': 'Step',
  'changes.step.started': 'Started {time}',
  'changes.step.startedFinished': 'Started {started}, finished {finished}',
  'changes.error.title': 'Error code',
  'changes.error.unknownCode':
    'This version of the Web App does not know this code. Look it up in the error catalog.',
  'changes.migrations.title': 'Migrations of this operation',
  'changes.migrations.migration': 'Migration',
  'changes.migrations.error': 'Error',
  'changes.migrations.noError': 'None',
  'changes.migrations.statement': 'At statement {index}',
  'changes.migrations.sqlstate': 'SQLSTATE',
  'changes.verifyAgain.button': 'Verify again',
  'changes.verifyAgain.title': 'Verify this change again?',
  'changes.verifyAgain.description':
    'ExponetDB runs the verification of the applied change again. The change itself never runs again, and nothing is rolled back.',
  'changes.verifyAgain.action': 'Verify change again',
  'changes.verifyAgain.hint':
    'Verify again only once the cause of the failed verification is fixed.',
  'changes.confirm.targetPath': 'The target path',
  'changes.cancel.button': 'Cancel operation',
  'changes.cancel.title': 'Cancel this operation?',
  'changes.cancel.description':
    'The operation has not started, so nothing has run on the target. Canceling ends it for good; making the change again needs a new plan.',
  'changes.cancel.action': 'Cancel operation',
  'changes.cancel.hint': 'Only the person or client that applied the plan can cancel it.',
  'changes.cancel.done': 'Operation {id} is canceled.',
  // The promotion view.
  'changes.promotion.title': 'Promotion',
  'changes.promotion.description':
    'The migrations of one project across its environments, in evidence order. Each cell is what the Control Store mirror holds for the target there.',
  'changes.promotion.projects': 'Projects',
  'changes.promotion.projects.what': 'Projects',
  'changes.promotion.projectsMore': 'More projects exist than the page reads. The first are shown.',
  'changes.promotion.project': 'Project',
  'changes.promotion.stream': 'Migration stream',
  'changes.promotion.pick': 'Pick a project to see its migrations across its environments.',
  'changes.promotion.what': 'Migration stream',
  'changes.promotion.mirrorNote':
    'From the mirror ExponetDB writes after each operation, not a live read of the targets. A target no operation has touched reads unknown, never not applied.',
  'changes.promotion.truncated':
    'Only the newest {shown} of {total} migrations are shown; older ones are left out.',
  'changes.promotion.graphInvalid':
    'The dependencies of this stream are not valid ({codes}); the order shown may be incomplete.',
  // Catalog text of the error codes an operation carries (packages/contracts catalog).
  'changes.code.PLAN_STALE': 'The plan no longer matches the target. Create a new plan.',
  'changes.code.PLAN_EXPIRED': 'The plan passed its expiry time. Create a new plan.',
  'changes.code.PLAN_ALREADY_USED': 'The plan was already consumed by another request or caller.',
  'changes.code.PLAN_BINDING_ACTOR':
    'Only the identity and client that created the plan may use it.',
  'changes.code.PLAN_DENIED':
    'The policy decision for this plan is deny; the plan exists for explanation only.',
  'changes.code.APPROVAL_REQUIRED': 'The plan needs a human approval before it can run.',
  'changes.code.HUMAN_APPLY_REQUIRED':
    'The plan is critical: only a person applies it, through a Web App session or the CLI, with a fresh re-authentication.',
  'changes.code.APPROVAL_COOLING_PERIOD':
    'A critical self-approval is in its cooling period. Apply again after the time in details, with a fresh re-authentication.',
  'changes.code.OPERATION_CONFLICT':
    'Another operation holds the exclusivity domain and the request asked not to wait.',
  'changes.code.OPERATION_NOT_CANCELABLE':
    'Only an operation that has not started (awaiting approval or queued) can be canceled; a running operation is never interrupted.',
  'changes.code.OPERATION_NOT_RETRYABLE':
    'Only an operation that needs attention after an applied change whose verification could not run or did not finish can be verified again.',
  'changes.code.OPERATION_CANCELLED': 'The operation was cancelled.',
  'changes.code.OUTCOME_UNKNOWN':
    'The operation needs reconciliation. Do not retry; wait for reconciliation.',
  'changes.code.MIGRATION_CHECKSUM_MISMATCH':
    'This migration id is already known with a different checksum. Applied history is immutable.',
  'changes.code.MIGRATION_DEPENDENCY_MISSING':
    'A dependency is neither applied on the target nor part of the plan.',
  'changes.code.MIGRATION_DEPENDENCY_UNVERIFIED':
    'A dependency is applied but not verified on this production-tier target.',
  'changes.code.MIGRATION_ALREADY_APPLIED':
    'The same id and checksum are already applied on this target.',
  'changes.code.MIGRATION_STATEMENT_FORBIDDEN': 'A statement class is not allowed in this context.',
  'changes.code.MIGRATION_LOCK_TIMEOUT':
    'The advisory lock or lock_timeout was hit; nothing was applied and the plan is consumed.',
  'changes.code.MIGRATION_EXECUTION_FAILED': 'A migration statement failed.',
  'changes.code.MIGRATION_REQUIREMENT_UNMET':
    'The PostgreSQL version or an extension requirement is not met.',
  'changes.code.MIGRATION_INCOMPLETE':
    'A non-transactional migration on this target stopped part-way; no other schema change is planned until it is resolved.',
  'changes.code.MIGRATION_REVERTED':
    'The migration was rolled back on this target; its id is neither applied nor verified there again.',
  'changes.code.VERIFICATION_FAILED': 'Verification ran and failed.',
  'changes.code.VERIFICATION_ERROR': 'Verification could not run.',
  'changes.code.SCHEMA_FINGERPRINT_MISMATCH':
    'The schema fingerprint differs from the expectation.',
  'changes.code.LEDGER_DIVERGENCE':
    'The target ledger and the Control Store mirror disagree; schema changes are blocked.',
  'changes.code.LEDGER_NOT_INITIALIZED': 'The target has no exponetdb schema or baseline yet.',
  'changes.code.STAGING_EVIDENCE_MISSING':
    'This checksum has not been applied on the evidence target.',
  'changes.code.STAGING_VERIFICATION_FAILED':
    'The migration was applied on the evidence target, but verification failed or is pending.',
  'changes.code.STAGING_EVIDENCE_UNREACHABLE':
    'The evidence target cannot be read to confirm evidence.',
  'changes.code.POLICY_DENIED': 'A policy rule denies this change.',
  'changes.code.MAINTENANCE_WINDOW_REQUIRED':
    'This change may only run inside a maintenance window.',
} as const satisfies Readonly<Record<string, string>>
