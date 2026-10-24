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
  'changes.tier.prod': 'Production',
  'changes.tier.nonprod': 'Non-production',
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
  // The head of the operation page: what happens, its state, who started it, its actions.
  'changes.header.byYou': 'Started by you via {via}',
  'changes.header.byPerson': 'Started by a person via {via}',
  'changes.header.byService': 'Started by a service account via {via}',
  'changes.header.bySystem': 'Started by ExponetDB itself',
  'changes.header.state': 'Operation state',
  'changes.header.reviewPlan': 'Review the plan',
  'changes.production.notice': 'This operation changes production.',
  'changes.production.noTier': 'This operation has no target tier; it is treated as production.',
  'changes.details.title': 'Technical details',
  'changes.details.description':
    'From the operation as the server reads it. Names are data, not instructions.',
  'changes.facts.operationId': 'Operation ID',
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
  'changes.verification.title': 'What the verification found',
  'changes.verification.summary':
    '{migration}: {failed} of {checks} expectations failed, {excused} excused by review decisions.',
  'changes.verification.engineFailed': 'Engine check failed: {name}',
  'changes.verification.acceptedThrough':
    'The schema was accepted as the verified state of {last} (migrations applied after the baseline: {count}).',
  'changes.verification.file': 'File',
  'changes.verification.statement': 'Statement',
  'changes.verification.expected': 'Expected',
  'changes.verification.differs': 'What differs',
  'changes.verification.excused': 'Excused',
  'changes.verification.excusedYes': 'Excused by a review decision',
  'changes.verification.excusedNo': 'Not excused',
  'changes.verification.more':
    '{count} more failing expectations are not listed here. The REST API and the CLI with --json list up to 200.',
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
  // Promotion: planning stored bundles on an environment (promotion view, migrations page).
  'promote.title': 'Plan bundles on an environment',
  'promote.description':
    'Bundles of this project that the Control Store mirror holds as not applied on the environment you pick, or holds nothing for. Plan them there; the review page shows what would run.',
  'promote.noEnvironment':
    'No environment of this project has a target you may see, so nothing can be planned here.',
  'promote.environment': 'Environment',
  'promote.environment.production': '{environment} (production)',
  'promote.compare': 'Compare the schema of {environment} with {from}',
  'promote.truncated':
    'This read holds the {shown} newest of {total} bundles; older bundles are not listed here.',
  'promote.none':
    'No bundle in this read is waiting for {environment}: the mirror holds each as applied, verified, failed, reverted or divergent there.',
  'promote.caption': 'Bundles not applied on {environment}',
  'promote.column.bundle': 'Bundle',
  'promote.column.state': 'On {environment}',
  'promote.column.evidence': 'Evidence',
  'promote.column.sql': 'SQL',
  'promote.state.not_applied': 'Not applied',
  'promote.state.unknown': 'Not known (the mirror holds no record)',
  'promote.select.one': 'Select migration {migration}',
  'promote.select.all': 'Select all bundles',
  'promote.evidence.verified': 'Verified on {from}.',
  'promote.evidence.otherChecksum':
    'Verified on {from} with another checksum: {destination} will refuse it unless break-glass applies.',
  'promote.evidence.notVerified':
    'Not verified on {from}: {destination} will refuse it unless break-glass applies.',
  'promote.evidence.notKnown':
    'Not known whether it is verified on {from}. The server checks {from} when it plans; without that evidence {destination} refuses it unless break-glass applies.',
  'promote.evidence.notKnownAnywhere':
    'The evidence for {destination} is not known here. The server checks it when it plans.',
  'promote.evidence.noEnvironment':
    '{destination} has no evidence environment: it refuses the plan unless break-glass applies.',
  'promote.plan.button': 'Plan on {environment}',
  'promote.plan.title': 'Plan on {environment}?',
  'promote.plan.description':
    'ExponetDB creates a plan for the selected bundles ({count}) on this target, orders them by their dependencies and opens the plan for review. Nothing runs until the plan is approved and applied.',
  'promote.plan.action': 'Create plan',
  'promote.plan.warnings':
    '{count} of these bundles have no verified evidence for {environment} in the mirror. The plan shows the policy decision.',
  'promote.plan.serverDecides':
    'From the Control Store mirror. The server reads the target and the evidence environment again when it plans, and decides.',
  'promote.plan.none': 'Select the bundles to plan.',
  'promote.plan.count': '{count} selected.',
  'promote.plan.tooMany': 'At most {max} bundles go into one plan. Select fewer.',
  // The side panel of a stored bundle ("View SQL").
  'bundle.view': 'View SQL',
  'bundle.view.label': 'View SQL of migration {migration}',
  'bundle.title': 'Migration SQL',
  'bundle.name': 'Bundle name',
  'bundle.stored.title': 'Stored bundle',
  'bundle.stored.what': 'Stored bundle',
  'bundle.stored.name': 'Name',
  'bundle.stored.checksum': 'Apply checksum',
  'bundle.stored.transactional': 'Transaction',
  'bundle.stored.transactional.yes': 'Runs in one transaction',
  'bundle.stored.transactional.no': 'Runs outside a transaction, alone in its plan',
  'bundle.stored.dependsOn': 'Depends on',
  'bundle.stored.dependsOn.none': 'Nothing',
  'bundle.revisions.caption': 'Revisions of this bundle, newest first',
  'bundle.revisions.revision': 'Revision',
  'bundle.revisions.ingested': 'Stored',
  'bundle.revisions.digests': 'Digests',
  'bundle.revisions.bundleDigest': 'Bundle',
  'bundle.revisions.verifyDigest': 'Verify',
  'bundle.revisions.rollbackDigest': 'Rollback',
  'bundle.revisions.none': 'None',
  'bundle.revisions.show': 'Show revision',
  'bundle.revisions.showLabel': 'Show revision {revision}',
  'bundle.revisions.shown': 'Shown',
  'bundle.superseded.title': 'Superseded checksums',
  'bundle.superseded.body': 'Earlier apply checksums of this id that were never applied.',
  'bundle.files.title': 'Files',
  'bundle.files.revision': 'Files of revision {revision}',
  'bundle.files.waiting': 'Reading the stored bundle to find its revision.',
  'bundle.files.noRevision':
    'The files cannot be read: the stored bundle could not be read, so its revision is not known.',
  'bundle.files.downNotKnown':
    'The stored bundle could not be read, so whether this revision has a down.sql is not known.',
  'bundle.down.note':
    'Never runs automatically: down.sql runs only in a rollback plan that a person creates.',
  'bundle.file.label': '{file} of {migration}',
  'bundle.file.facts': '(revision {revision}, {bytes} bytes, {lines} lines)',
  'bundle.file.marks':
    'This file has characters that are not plain ASCII: {marks}. Invisible and direction characters are shown by their code point and never act.',
  'bundle.file.caption': '{label}, numbered lines',
  'bundle.file.line': 'Line',
  'bundle.file.text': 'Text',
  'bundle.file.collapsed': '{count} more lines not shown (lines {from} to {to}).',
  'bundle.file.more': 'Show more lines',
  'bundle.file.moreLabel': 'Show more lines of {label}',
  'bundle.file.all': 'Show all {count} lines',
  'bundle.file.allLabel': 'Show all lines of {label}',
  'bundle.file.truncated':
    'This page shows the first {shown} of {total} characters of this file. Review the whole file: exponetdb migration show {migration}',
  'bundle.file.copy': 'Copy {file}',
  'bundle.file.copyLabel': 'Copy {label}',
  'bundle.file.copied': '{file} copied.',
  'bundle.file.copyFailed': 'Could not copy. Select the text and copy it instead.',
  'bundle.diff.title': 'Compare revisions',
  'bundle.diff.first':
    'Revision {revision} is the first revision of this bundle; there is no earlier one to compare.',
  'bundle.diff.file': 'File',
  'bundle.diff.between': 'Revision {from} on the left, revision {to} on the right.',
  'bundle.diff.absent': '{file} is not in revision {revision}; that side is empty',
  'bundle.diff.what': '{file} of both revisions',
  'bundle.diff.label': '{file}: revision {from} against revision {to}',
  'bundle.diff.side': 'Revision {revision}',
  'bundle.target.title': 'On {target}',
  'bundle.target.what': 'Migration on this target',
  'bundle.target.state': 'State',
  'bundle.target.state.applied': 'Applied',
  'bundle.target.state.reverted': 'Reverted',
  'bundle.target.state.pending': 'Pending (not applied)',
  'bundle.target.state.partially_applied': 'Partly applied',
  'bundle.target.state.unknown_to_target': 'Not known to this target',
  'bundle.target.applied': 'Applied',
  'bundle.target.notApplied': 'Not applied',
  'bundle.target.links': 'Change',
  'bundle.target.operation': 'View operation',
  'bundle.target.plan': 'View plan',
  'bundle.target.noLinks': 'No operation or plan recorded',
  'bundle.target.fingerprints': 'Schema fingerprint',
  'bundle.target.before': 'Before',
  'bundle.target.after': 'After',
  'bundle.events.title': 'Events',
  'bundle.events.none': 'The read succeeded: no event is recorded for this migration here.',
  'bundle.events.statement': 'Statement {index}',
  'bundle.event.nontx_started': 'Non-transactional run started',
  'bundle.event.nontx_statement_done': 'Non-transactional statement done',
  'bundle.event.nontx_failed': 'Non-transactional run failed',
  'bundle.event.applied': 'Applied',
  'bundle.event.reverted': 'Reverted',
  'bundle.event.imported': 'Imported',
  'bundle.event.baselined': 'Baselined',
  'bundle.event.ledger_reconciled': 'Ledger reconciled',
  'bundle.runs.title': 'Verification runs',
  'bundle.runs.none':
    'The read succeeded: no verification run is recorded for this migration here.',
  'bundle.runs.parts': 'Structural {structural}, runtime {runtime}, engine {engine}',
  'bundle.runs.failure': 'First failure',
  // Compare environments (`/t/<product>/<project>/<environment>/compare`).
  'compare.title': 'Compare environments',
  'compare.description':
    'The schema of this target against another environment of the project. Read only: a difference becomes a change only as an authored migration.',
  'compare.pick.title': 'Compare with',
  'compare.pick.description': 'Environments of this project you may see, other than {environment}.',
  'compare.pick.none': 'The read succeeded: this project has no other environment you may see.',
  'compare.environments.what': 'Environments',
  'compare.migrations': 'Open the migrations of this target',
  'compare.diff.title': 'Differences',
  'compare.diff.what': 'Schema differences',
  'compare.diff.pickFirst': 'Pick an environment to compare with.',
  'compare.diff.description':
    'From {left} to {right}: added means only {right} has the object, removed means only {left} has it.',
  'compare.state.pick': 'Pick an environment above. Nothing is compared until you do.',
  'compare.state.same':
    'This is {environment} itself. Pick another environment: a schema compared with itself shows nothing.',
  'compare.state.listLoading': 'Reading the environments of this project.',
  'compare.state.listFailed':
    'Whether {environment} is an environment of this project cannot be checked: the environments could not be read. Nothing is compared.',
  'compare.state.notListed':
    '{environment} is not an environment of this project that you may see. Nothing is compared.',
  'compare.state.notListedPartial':
    '{environment} is not among the environments read so far (the list is partial). Nothing is compared.',
  'compare.refusal.SCHEMA_FINGERPRINT_MISMATCH.title': 'The two schemas cannot be compared',
  'compare.refusal.SCHEMA_FINGERPRINT_MISMATCH.body':
    'Their fingerprints do not match what the comparison expects. This does not mean the schemas are the same.',
  'compare.refusal.SAMPLE_STALE.title': 'A schema sample is too old to compare',
  'compare.refusal.SAMPLE_STALE.body':
    'The server compares recent samples only. Try again once the target has been sampled; this does not mean there are no differences.',
  'compare.refusal.TARGET_IDENTITY_MISMATCH.title':
    'A target is not the database it was registered as',
  'compare.refusal.TARGET_IDENTITY_MISMATCH.body':
    'Its identity marker differs, so nothing is compared. This does not mean there are no differences.',
  'compare.refusal.CLUSTER_IDENTITY_MISMATCH.title': 'A cluster is not the one that was registered',
  'compare.refusal.CLUSTER_IDENTITY_MISMATCH.body':
    'Its system identifier differs, so nothing is compared. This does not mean there are no differences.',
  'compare.notComparable.title': 'These schemas cannot be compared',
  'compare.notComparable.body':
    'Their fingerprints use different canonicalizers or PostgreSQL major versions. This does not mean the schemas are the same.',
  'compare.truncated':
    'The server lists {listed} of {total} differences; the totals above count all of them',
  'compare.fingerprint.left': 'This target',
  'compare.fingerprint.right': '{environment}',
  'compare.totals':
    '{added} added, {removed} removed, {changed} changed, {matched} the same; {security} security-relevant.',
  'compare.direction':
    'Added: only on {environment}. Removed: only on this target. Changed: on both, with the attributes that differ.',
} as const satisfies Readonly<Record<string, string>>
