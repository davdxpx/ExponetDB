/**
 * Messages of the target pages that read what the Control Store keeps
 * (`src/features/migrations`, `findings`, `drift`, `activity`,
 * `configuration`). One part, registered once in `en.ts`.
 */
const migrationsMessages = {
  'migrations.description':
    'Where this target stands in its migration history. A change is a plan; nothing runs from this page.',
  'migrations.ledger.title': 'Ledger',
  'migrations.ledger.description':
    'The migrations applied to this database, read from its own ledger, and the bundles still pending.',
  'migrations.ledger.what': 'Ledger',
  'migrations.ledger.caption': 'Applied migrations of this target',
  'migrations.ledger.sourceUnknown': 'Source not reported.',
  'migrations.ledger.observed': 'Observed',
  'migrations.ledger.baseline': 'Baseline',
  'migrations.ledger.hash': 'Ledger state hash',
  'migrations.ledger.empty': 'The read succeeded: no migration is applied to this target yet.',
  'migrations.ledger.mirrorDiffers.title': 'The Control Store mirror differs from the ledger',
  'migrations.ledger.mirrorDiffers.body':
    'The ledger in the target is the truth. The mirror is the copy the timeline and other pages use; it catches up after the next operation, or it shows a change made outside ExponetDB.',
  'migrations.ledger.incomplete.title': 'A non-transactional migration did not finish',
  'migrations.ledger.incomplete.body':
    'It blocks schema plans for this target until it is resumed or cleaned up:',
  'migrations.ledger.column.migration': 'Migration',
  'migrations.ledger.column.checksum': 'Checksum',
  'migrations.ledger.column.origin': 'Origin',
  'migrations.ledger.column.applied': 'Applied',
  'migrations.ledger.column.verification': 'Verification',
  'migrations.ledger.column.sql': 'SQL',
  'migrations.ledger.operation': 'View operation',
  'migrations.ledger.reverted': 'Reverted',
  'migrations.verification.passed': 'Verified',
  'migrations.verification.pending': 'Verification pending',
  'migrations.verification.failed': 'Verification failed',
  'migrations.verification.partial': 'Partly verified',
  'migrations.verification.error': 'Verification could not run',
  'migrations.pending.title': 'Pending bundles',
  'migrations.pending.caption': 'Bundles of the project not yet applied to this target',
  'migrations.pending.empty': 'The read succeeded: no bundle is pending for this target.',
  'migrations.timeline.title': 'Across environments',
  'migrations.timeline.description':
    'Each bundle in dependency order, one column per environment. A cell with no record reads unknown, never not applied.',
  'migrations.timeline.what': 'Migration timeline',
  'migrations.timeline.environment': 'Environment',
  'migrations.timeline.compare': 'Compare the schema with another environment',
  'migrations.timeline.graphInvalid':
    'The bundle graph is not valid, so the bundles are listed by id and not in dependency order.',
  'migrations.timeline.noTarget':
    'No target you may see, so its column says nothing about it (unknown).',
  'migrations.timeline.noMirror':
    'The Control Store holds no record of its target at its current generation (unknown).',
  'migrations.timeline.divergent':
    'The mirror differs from the target ledger: {missing} missing, {differs} with another checksum, {unrecorded} unrecorded.',
  'migrations.plans.title': 'Plans for this target',
  'migrations.plans.description':
    'The newest plans, with the state of each. A plan is reviewed, approved and applied on its own page.',
  'migrations.plans.what': 'Plans for this target',
  'migrations.plans.caption': 'Newest plans for this target',
  'migrations.plans.more': 'More plans exist than this list shows. The newest are shown.',
  'migrations.plans.all': 'Open all plans',
  'migrations.plans.column.plan': 'Plan',
  'migrations.plans.column.change': 'Change',
  'migrations.plans.column.state': 'State',
  'migrations.plans.column.created': 'Created',
  'migrations.drift.title': 'Drift findings',
  'migrations.drift.description':
    'Differences between the schema ExponetDB expects and the schema this target has.',
  'migrations.drift.what': 'Drift findings',
  'migrations.drift.empty': 'The read succeeded: this target has no open drift finding.',
  'migrations.drift.more': 'More open drift findings exist than this list shows.',
  'migrations.drift.object': 'Drifted object',
  'migrations.drift.open': 'Compare expected and actual on the Drift page',
  'migrations.import.title': 'Legacy import',
  'migrations.import.description':
    'Review how the files of a legacy migration tool map to this target before a baseline is written.',
  'migrations.import.what': 'Import report',
  'migrations.import.none':
    'No import report is open. An analysis plan creates the report; open it here by its id.',
  'migrations.import.open.label': 'Import report id',
  'migrations.import.open.button': 'Open report',
  'migrations.import.open.invalid':
    'That is not an import report id. It looks like imr_ followed by 26 characters.',
  'migrations.import.state': 'State',
  'migrations.import.report.pending': 'Pending',
  'migrations.import.report.incomplete': 'Incomplete',
  'migrations.import.report.open': 'Open, waiting for decisions',
  'migrations.import.report.resolved': 'Resolved, ready for a baseline',
  'migrations.import.report.baselined': 'Baselined',
  'migrations.import.report.superseded': 'Superseded',
  'migrations.import.unresolved': '{count} unresolved',
  'migrations.import.baselineId': 'Baseline',
  'migrations.import.created': 'Created',
  'migrations.import.incomplete': 'The analysis could not finish',
  'migrations.import.noItems': 'The report has no items.',
  'migrations.import.caption': 'Files of the legacy import and their classification',
  'migrations.import.column.file': 'File',
  'migrations.import.column.classification': 'Classification',
  'migrations.import.column.evidence': 'Evidence',
  'migrations.import.column.decision': 'Decision',
  'migrations.import.noEvidence': 'None recorded',
  'migrations.import.strength': 'Ledger evidence:',
  'migrations.import.strength.strong': 'Strong (tool hash or the same statements)',
  'migrations.import.strength.medium': 'Medium (the same statements, comments ignored)',
  'migrations.import.strength.low': 'Low (the same code, comments in bodies ignored)',
  'migrations.import.strength.curated': 'Curated (an alias)',
  'migrations.import.strength.weak': 'Weak (the name only; not recorded)',
  'migrations.import.truncated.title': 'This report does not hold all of its drift',
  'migrations.import.truncated.body':
    'It holds {held} of {total} drift entries, so it cannot become a baseline. Narrow the managed schemas or correct the import inputs, then analyze again.',
  'migrations.import.undecided': 'Waiting for a decision',
  'migrations.import.noDecisionNeeded': 'No decision needed',
  'migrations.import.note':
    'A decision is stored on the report with your note. It changes nothing in the target.',
  'migrations.import.note.label': 'Decision note',
  'migrations.import.state.recorded_present': 'Recorded and present',
  'migrations.import.state.unrecorded_present': 'Not recorded, effect present',
  'migrations.import.state.recorded_missing': 'Recorded, effect missing',
  'migrations.import.state.unrecorded_missing': 'Not recorded, effect missing',
  'migrations.import.state.superseded': 'Superseded by a later file',
  'migrations.import.state.not_applicable': 'Not applicable to this target',
  'migrations.import.state.ambiguous': 'Ambiguous',
  'migrations.import.decide.button': 'Decide',
  'migrations.import.decide.title': 'Record a decision',
  'migrations.import.decide.description':
    'The decision and your note are stored on the import report. Nothing changes in the target.',
  'migrations.import.decide.action': 'Record decision',
  'migrations.import.decide.state': 'Decision',
  'migrations.import.decide.choose': 'Choose a decision',
  'migrations.import.decide.note': 'Note',
  'migrations.import.decide.noteHint': 'Required, at most {max} characters.',
  'migrations.import.failing':
    '{count} of its expectations did not hold on the target when the analysis ran.',
  'migrations.import.decide.excuses':
    "Accepting this file as applied excuses its {count} failing expectations at the baseline's verification, as they fail now. Any other failure still fails the verification.",
  'migrations.import.decide.excusesMore': 'And {count} more.',
  'migrations.import.decide.excusesUnread':
    'Some of these checks could not be read on the imported target, so nobody saw what they would find. Accepting excuses that too. To check them, give the observer the reads it lacks and analyze again.',
  'migrations.import.decide.excusesNothing':
    "Accepting this file as applied excuses nothing: every expectation it states must hold at the baseline's verification.",
  'migrations.import.decide.supersededUnchecked':
    "The baseline's verification does not check a file recorded as superseded.",
  'migrations.import.decide.stateMissing': 'Choose a decision first.',
  'migrations.import.decide.noteMissing': 'Write a note first.',
  'migrations.import.baseline.ready': 'Every review item has a decision.',
  'migrations.import.baseline.button': 'Create baseline plan',
  'migrations.import.baseline.title': 'Create the baseline plan',
  'migrations.import.baseline.description':
    'This creates a plan that records the reviewed files as the baseline of this target. Nothing is written until the plan is reviewed and applied.',
  'migrations.import.baseline.action': 'Create plan',
} as const

const findingsMessages = {
  'findings.description':
    'What ExponetDB found out about this target: drift from the expected schema and health conditions.',
  'findings.what': 'Findings',
  'findings.caption': 'Findings of this target, newest first',
  'findings.filters.label': 'Filter findings',
  'findings.filters.severity': 'Severity',
  'findings.filters.state': 'State',
  'findings.filters.kind': 'Kind',
  'findings.filters.any': 'Any',
  'findings.severity.info': 'Info',
  'findings.severity.warning': 'Warning',
  'findings.severity.critical': 'Critical',
  'findings.severity.unknown': 'Unknown severity',
  'findings.state.open': 'Open',
  'findings.state.resolved': 'Resolved',
  'findings.state.all': 'Open and resolved',
  'findings.kind.drift': 'Drift',
  'findings.kind.health': 'Health',
  'findings.empty': 'The read succeeded: this target has no open finding.',
  'findings.emptyFiltered': 'The read succeeded: no finding matches these filters.',
  'findings.more': 'More findings exist than the pages read so far.',
  'findings.loadMore': 'Load more findings',
  'findings.column.severity': 'Severity',
  'findings.column.finding': 'Finding',
  'findings.column.kind': 'Kind',
  'findings.column.code': 'Code',
  'findings.column.object': 'Object',
  'findings.column.seen': 'Seen',
  'findings.column.state': 'State',
  'findings.securityRelevant': 'Security-relevant',
  'findings.noObject': 'No object',
  'findings.firstSeen': 'First seen',
  'findings.lastSeen': 'Last seen',
  'findings.occurrences': 'Seen {count} times',
  'findings.openDrift': 'Open on the Drift page',
} as const

const driftMessages = {
  'drift.description':
    'Where the schema this target has differs from the schema ExponetDB expects. Accepting drift adopts the current schema and changes no DDL.',
  'drift.check.title': 'Drift check',
  'drift.check.description':
    'A check compares the current schema with the expected one and records its findings. It changes nothing in the target.',
  'drift.check.run': 'Run drift check',
  'drift.check.failed': 'The drift check failed',
  'drift.check.thisRun': 'Result of the check you just ran',
  'drift.last.title': 'Last check',
  'drift.last.what': 'Drift checks',
  'drift.last.none':
    'No drift check is recorded for this target. The read succeeded and found none.',
  'drift.last.checked': 'Last checked',
  'drift.last.counts': 'Findings',
  'drift.last.baseline': 'Baseline fingerprint',
  'drift.last.current': 'Current fingerprint',
  'drift.last.notRecorded': 'Not recorded',
  'drift.last.findingsNote':
    'Findings are not stored per check; the open findings below are the ones the server keeps.',
  'drift.last.otherGeneration':
    'This check ran against generation {generation}, not the current generation {current}.',
  'drift.last.status.clean': 'Clean',
  'drift.last.status.drifted': 'Drifted',
  'drift.last.status.incomplete': 'Incomplete',
  'drift.last.status.no_baseline': 'No baseline',
  'drift.last.status.not_comparable': 'Not comparable',
  'drift.last.status.failed': 'Failed',
  'drift.last.status.incomplete.note': 'Part of the schema could not be read.',
  'drift.last.status.no_baseline.note': 'There is no expected schema to compare with yet.',
  'drift.last.status.not_comparable.note':
    'The expected and current schema come from different fingerprint or PostgreSQL versions.',
  'drift.last.status.failed.note': 'The check failed.',
  'drift.last.status.nothing': 'Nothing was compared, so this is not a clean result.',
  'drift.last.status.unknown': 'This page does not know this status, so it shows no counts.',
  'drift.history.title': 'The last {count} checks',
  'drift.history.caption': 'Recent drift checks, newest first',
  'drift.history.column.checked': 'Checked',
  'drift.history.column.by': 'Run by',
  'drift.by.schedule': 'The schedule',
  'drift.by.identity': 'A person or service account',
  'drift.by.unknown': 'Not recognized',
  'drift.history.column.status': 'Status',
  'drift.history.column.result': 'Result',
  'drift.history.result': '{drifted} drifted, {unmanaged} unmanaged, {matched} matched',
  'drift.history.noResult': 'Nothing was compared',
  'drift.history.older': 'Older checks exist. Only the last {count} are listed.',
  'drift.check.checked': 'Checked',
  'drift.check.status': 'Status',
  'drift.check.errorCode': 'Error code',
  'drift.check.truncated.title': 'The check lists only part of its findings',
  'drift.check.truncated.body':
    'More items were compared than one check lists. The counts above cover all of them.',
  'drift.check.noFingerprint': 'No schema fingerprint was recorded for this check.',
  'drift.count.drifted': 'Drifted',
  'drift.count.unmanaged': 'Unmanaged',
  'drift.count.matched': 'Matched',
  'drift.count.opened': 'Opened',
  'drift.count.updated': 'Updated',
  'drift.count.resolved': 'Resolved',
  'drift.open.title': 'Open drift findings',
  'drift.open.description': 'Most severe first. These stay open until they are accepted or fixed.',
  'drift.open.what': 'Open drift findings',
  'drift.open.caption': 'Open drift findings of this target',
  'drift.open.count': '{count} open',
  'drift.open.lastSeen': 'Last seen by a check',
  'drift.open.more': 'More open drift findings exist than the pages read so far.',
  'drift.open.allFindings': 'Open all findings of this kind',
  'drift.open.column.severity': 'Severity',
  'drift.open.column.object': 'Object',
  'drift.open.column.code': 'Code',
  'drift.open.column.summary': 'Summary',
  'drift.open.column.seen': 'Last seen',
  'drift.triage.title': 'Result of the check',
  'drift.triage.description':
    'Drifted items first, with the expected and the actual value side by side. A value that is absent says so.',
  'drift.bucket.drifted': 'Drifted',
  'drift.bucket.unmanaged': 'Unmanaged',
  'drift.bucket.matched': 'Matched',
  'drift.bucket.other': 'Other',
  'drift.bucket.empty': 'The check found nothing in this group.',
  'drift.column.object': 'Object',
  'drift.column.expected': 'Expected',
  'drift.column.actual': 'Actual',
  'drift.absent': 'Absent',
  'drift.kind': 'Comparison {kind}',
  'drift.explained': 'Explained by an operation',
  'drift.accept.button': 'Accept drift',
  'drift.accept.title': 'Accept drift',
  'drift.accept.description':
    'This creates a plan that adopts the current schema of this target as its baseline and resolves its open drift findings as accepted. No DDL runs, and nothing changes until the plan is applied.',
  'drift.accept.descriptionCount':
    'This creates a plan that adopts the current schema of this target as its baseline and resolves its {count} open drift findings as accepted. No DDL runs, and nothing changes until the plan is applied.',
  'drift.accept.action': 'Create plan',
  'drift.accept.explain':
    'The plan covers every open drift finding of this target, not only one row.',
  'drift.accept.permanent.title': 'The reason is permanent',
  'drift.accept.permanent.body':
    'It is written to the audit log and cannot be changed or removed. Do not put personal data, secrets or customer names in it.',
  'drift.accept.reason.optional': 'Reason (optional)',
  'drift.accept.reason.required': 'Reason (required for this finding)',
  'drift.accept.reason.hint':
    'Needed when a covered finding is critical or security-relevant. {min} to {max} characters.',
  'drift.accept.reasonRequired':
    'A critical or security-relevant drift is accepted only with a reason (reason_required). Enter a reason and create the plan again.',
  'drift.accept.reasonShort': 'A reason needs at least 10 characters.',
} as const

const activityMessages = {
  'activity.description':
    'What was done to this target: the operations that ran and the audit events that recorded who asked for them.',
  'activity.loadMore': 'Load more',
  'activity.viewPlan': 'View plan',
  'activity.operations.title': 'Operations',
  'activity.operations.description':
    'What ran, newest first. Applied and verified are kept apart: an applied change is not yet a verified one.',
  'activity.operations.what': 'Operations',
  'activity.operations.caption': 'Operations on this target, newest first',
  'activity.operations.more': 'More operations exist than the pages read so far.',
  'activity.operations.column.operation': 'Operation',
  'activity.operations.column.state': 'State',
  'activity.operations.column.applied': 'Applied',
  'activity.operations.column.verified': 'Verified',
  'activity.operations.column.actor': 'Actor',
  'activity.operations.column.created': 'Created',
  'activity.audit.title': 'Audit events',
  'activity.audit.description':
    'Who asked for what, newest first. Actors are pseudonyms; a client name is what the client called itself.',
  'activity.audit.what': 'Audit events',
  'activity.audit.caption': 'Audit events of this target, newest first',
  'activity.audit.more': 'More audit events exist than the pages read so far.',
  'activity.audit.reason': 'Reason:',
} as const

const configurationMessages = {
  'configuration.description':
    'How this target is set up. Every change is a plan you review first; settings change through plans on their own pages.',
  'configuration.target.title': 'Target',
  'configuration.target.description': 'What the registry says about this database.',
  'configuration.target.path': 'Path',
  'configuration.target.tier': 'Tier',
  'configuration.target.state': 'Lifecycle',
  'configuration.target.generation': 'Generation',
  'configuration.target.placement': 'Cluster',
  'configuration.target.noPlacement': 'Not placed on a cluster',
  'configuration.target.mode': 'Management mode: {mode}',
  'configuration.target.version': 'PostgreSQL version',
  'configuration.target.openCluster': 'Open the cluster',
  'configuration.dataRead.title': 'Data-read policy',
  'configuration.dataRead.description':
    'Who may read rows of this target. Agents and service accounts follow this setting whatever scopes they hold.',
  'configuration.dataRead.what': 'Data-read policy',
  'configuration.dataRead.notListed':
    'The policy settings do not list a data-read rule, so this page cannot say what applies.',
  'configuration.dataRead.mode': 'Mode',
  'configuration.dataRead.mode.by_tier':
    'By tier: people read every tier, agents read non-production only',
  'configuration.dataRead.mode.enabled': 'Enabled: people and agents read rows',
  'configuration.dataRead.mode.humans_only': 'People only: agents read no rows',
  'configuration.dataRead.mode.disabled': 'Disabled: nobody reads rows',
  'configuration.dataRead.mode.unreadable': 'The setting cannot be read, so reads are refused',
  'configuration.dataRead.from': 'Set at',
  'configuration.dataRead.from.target': 'This target',
  'configuration.dataRead.from.environment': 'The environment',
  'configuration.dataRead.from.project': 'The project',
  'configuration.dataRead.from.product': 'The product',
  'configuration.dataRead.from.installation': 'The installation',
  'configuration.dataRead.from.default': 'The rule default (no setting configured)',
  'configuration.dataRead.fromRevision': '{from}, revision {revision}',
  'configuration.dataRead.columns': 'Sensitive columns',
  'configuration.dataRead.noColumns': 'None listed',
  'configuration.dataRead.note':
    'The server decides at every read. A change is a plan made on the policies page.',
  'configuration.dataRead.change': 'Open policies',
  'configuration.postgres.title': 'PostgreSQL settings',
  'configuration.postgres.description':
    'The settings of the PostgreSQL server this database runs on.',
  'configuration.postgres.unavailable.title': 'PostgreSQL settings are not readable here yet',
  'configuration.postgres.unavailable.body':
    'The Control Plane keeps no copy of server settings. They come from a node inspection of the host, which this page does not start. Nothing is shown rather than an unverified value.',
  'configuration.roles.title': 'Cluster roles',
  'configuration.roles.description':
    'The login roles ExponetDB uses on the cluster of this target. Passwords and verifiers are never shown.',
  'configuration.roles.what': 'Cluster roles',
  'configuration.roles.caption': 'Roles of the cluster of this target',
  'configuration.roles.more': 'More roles exist than this list shows.',
  'configuration.roles.noCluster':
    'This target is not placed on a cluster, so it has no cluster roles.',
  'configuration.roles.manage': 'Manage roles on the infrastructure pages',
  'configuration.roles.column.role': 'Role',
  'configuration.roles.column.access': 'Access',
  'configuration.roles.column.state': 'State',
  'configuration.roles.column.verified': 'Verified',
  'configuration.roles.notVerified': 'Not verified',
  // Identity rows: copy the path and the id.
  'configuration.target.id': 'Target ID',
  'configuration.copy.path': 'Target path',
  'configuration.copy.path.label': 'Copy target path',
  'configuration.copy.id': 'Target ID',
  'configuration.copy.id.label': 'Copy target ID',
  // Lifecycle: suspend, resume, decommission (each a plan).
  'configuration.lifecycle.title': 'Lifecycle',
  'configuration.lifecycle.description':
    'Stop writes to this target, allow them again, or retire it. Every change is a plan: you review it before anything happens.',
  'configuration.lifecycle.notPermitted': 'Lifecycle changes',
  'configuration.lifecycle.state': 'This target is {state}.',
  'configuration.lifecycle.reason.label': 'Reason code',
  'configuration.lifecycle.reason.labelOptional': 'Reason code (optional)',
  'configuration.lifecycle.reason.hint':
    'A short code: lowercase letters, digits and underscores, starting with a letter, such as maintenance_window.',
  'configuration.lifecycle.reason.required': 'Enter a reason code.',
  'configuration.lifecycle.reason.invalid':
    'Use lowercase letters, digits and underscores, starting with a letter, up to 64 characters.',
  'configuration.lifecycle.suspend.title': 'Suspend writes',
  'configuration.lifecycle.suspend.body':
    'Writes to this target stop. Observation continues, so health, drift and the schema stay current. A suspended target can be resumed.',
  'configuration.lifecycle.suspend.submit': 'Plan suspension',
  'configuration.lifecycle.suspend.registered':
    'Suspension applies to active targets. This target is registered but not active yet.',
  'configuration.lifecycle.suspend.confirm.title': 'Create the suspension plan?',
  'configuration.lifecycle.suspend.confirm.body':
    'The plan suspends {path}: no migration or other write runs on it while it is suspended. Nothing changes until the plan is applied.',
  'configuration.lifecycle.suspend.confirm.action': 'Create suspension plan',
  'configuration.lifecycle.resume.title': 'Resume writes',
  'configuration.lifecycle.resume.body':
    'Allows writes to this target again. ExponetDB checks the identity marker of the database first and refuses to resume a database that no longer carries it.',
  'configuration.lifecycle.resume.submit': 'Plan resumption',
  'configuration.lifecycle.resume.confirm.title': 'Create the resumption plan?',
  'configuration.lifecycle.resume.confirm.body':
    'The plan resumes {path} and allows writes again. Nothing changes until the plan is applied.',
  'configuration.lifecycle.resume.confirm.action': 'Create resumption plan',
  'configuration.lifecycle.decommission.title': 'Decommission',
  'configuration.lifecycle.decommission.body':
    'Retires this target for good. Its path is never reused. Decommissioning ends the placement and changes nothing in the database; the database keeps its identity marker, so it cannot be registered as another target by accident.',
  'configuration.lifecycle.decommission.submit': 'Plan decommission',
  'configuration.lifecycle.decommission.confirm.title': 'Create the decommission plan?',
  'configuration.lifecycle.decommission.confirm.body':
    'The plan decommissions {path}. The path is never reused and the target cannot be brought back. Nothing changes until the plan is applied.',
  'configuration.lifecycle.decommission.confirm.action': 'Create decommission plan',
  'configuration.lifecycle.decommission.typedName': 'The target path',
  'configuration.lifecycle.decommissioned':
    'This target is decommissioned. Its path is never reused, and no lifecycle change is available.',
  // Connect: where applications connect, without any secret.
  'configuration.connect.title': 'Connect',
  'configuration.connect.description':
    'Where applications connect to this database. They connect directly: ExponetDB is never in the path and never holds an application password.',
  'configuration.connect.what': 'Connection endpoints',
  'configuration.connect.notPermitted.title':
    'Only registry administrators can see endpoint addresses',
  'configuration.connect.notPermitted.body':
    'Endpoint addresses need the registry.manage permission. ExponetDB did not ask for them.',
  'configuration.connect.noPlacement':
    'This target is not placed on a cluster, so there is no endpoint to connect to.',
  'configuration.connect.empty':
    'The read succeeded and the cluster has no active endpoint an application can use.',
  'configuration.connect.missing.endpoints': 'More endpoints exist than this list shows.',
  'configuration.connect.missing.databases':
    'More databases exist on the cluster than the server listed, so the database of this target may be missing.',
  'configuration.connect.missing.databaseUnknown':
    'The database name: the cluster lists no database placed on this target.',
  'configuration.connect.missing.databaseFailed': 'The database name could not be read: {reason}',
  'configuration.connect.kind.private': 'Direct, private',
  'configuration.connect.kind.public': 'Direct, public',
  'configuration.connect.kind.pooler': 'Pooler, {mode} mode',
  'configuration.connect.kind.poolerUnknown': 'Pooler',
  'configuration.connect.localSockets':
    '{count} local socket endpoints are not listed: they are for the host only, not for applications.',
  'configuration.connect.host': 'Host',
  'configuration.connect.port': 'Port',
  'configuration.connect.database': 'Database',
  'configuration.connect.database.notKnown': 'Not known',
  'configuration.connect.tls': 'TLS server name',
  'configuration.connect.sslmode': 'SSL mode',
  'configuration.connect.check': 'Endpoint check',
  'configuration.connect.check.none':
    'No probe of this endpoint is recorded yet, so it is not verified.',
  'configuration.connect.check.tls.verified': 'TLS verified',
  'configuration.connect.check.tls.failed': 'TLS failed',
  'configuration.connect.check.tls.not_reached': 'TLS not reached',
  'configuration.connect.check.tls.mixed': 'TLS partly verified',
  'configuration.connect.check.probes': '{ok} of {total} probes ok',
  'configuration.connect.check.identity.verified': 'Endpoint identity verified',
  'configuration.connect.check.identity.unverified': 'Endpoint identity not verified',
  'configuration.connect.check.denied':
    'Probe results need the diagnostics.read permission, so the endpoint check is not shown.',
  'configuration.connect.check.failed': 'The probe results could not be read: {reason}',
  'configuration.connect.check.loading': 'Reading the probe results.',
  'configuration.connect.uri': 'Connection URI',
  'configuration.connect.uri.copy': 'Copy connection URI',
  'configuration.connect.psql': 'Command for psql',
  'configuration.connect.psql.copy': 'Copy command for psql',
  'configuration.connect.unsafe.database':
    'No command is shown: the database name contains characters that are not safe to paste into a shell or a URI.',
  'configuration.connect.unsafe.host':
    'No command is shown: the host contains characters that are not safe to paste into a shell or a URI.',
  'configuration.connect.note':
    'Replace <role> and [YOUR-PASSWORD] with an application role of your own: ExponetDB never holds application passwords. sslmode=verify-full needs the CA certificate that signed the server certificate (sslrootcert).',
  'configuration.connect.ip':
    'The endpoint is an address, so the server certificate is checked against {name} and the address goes in hostaddr.',
} as const

export const targetPageMessages = {
  ...migrationsMessages,
  ...findingsMessages,
  ...driftMessages,
  ...activityMessages,
  ...configurationMessages,
} as const
