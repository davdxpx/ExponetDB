/**
 * Messages of the audit page (`src/features/audit/`): search and filters,
 * event details, the chain verification indicator (audit.md §4) and the
 * export for offline verification (audit.md §5.1, owner decision S7).
 */
export const auditMessages = {
  'audit.title': 'Audit',
  'audit.description':
    'Every request ExponetDB accepted, refused or completed, newest first, in an append-only hash chain. Actors are shown by pseudonym.',

  // ----- chain -----
  'audit.chain.what': 'Audit chain verification',
  'audit.chain.recheck': 'Verify again',
  'audit.chain.verified.full':
    'The whole chain was checked: {count} events through sequence {through}.',
  'audit.chain.verified.fromCheckpoint':
    'Checked from the latest checkpoint: {count} events, sequence {from} through {through}.',
  'audit.chain.broken': 'The chain does not hold at sequence {seq}: {reason}',
  'audit.chain.broken.sequence_gap': 'A sequence number is missing.',
  'audit.chain.broken.prev_hash_mismatch':
    'An event does not point to the hash of the event before it.',
  'audit.chain.broken.not_canonical': 'An event is not stored in its canonical form.',
  'audit.chain.broken.invalid_event': 'An event cannot be read as an audit event.',
  'audit.chain.broken.columns_mismatch': 'An event’s columns differ from its hashed content.',
  'audit.chain.broken.hash_mismatch': 'An event’s hash does not match its content.',
  'audit.chain.broken.checkpoint_mismatch': 'A checkpoint does not match the event it anchors.',
  'audit.chain.broken.anchor_missing': 'The checkpoint the check starts from has no event.',
  'audit.chain.reason.other': 'Reason {code}.',
  'audit.chain.notVerified': 'Not verified yet. {detail}',
  'audit.chain.notVerified.tooMany':
    'More than {limit} events ({count}) were written since the latest checkpoint, so this page does not walk them. The worker checks the chain hourly and daily.',
  'audit.chain.notVerified.empty': 'The audit log has no events yet.',
  'audit.chain.notVerified.other': 'Reason {code}.',
  'audit.chain.head': 'Newest event',
  'audit.chain.head.none': 'None yet',
  'audit.chain.head.value': 'Sequence {seq}',
  'audit.chain.checkpoint': 'Latest checkpoint',
  'audit.chain.checkpoint.none': 'None yet',
  'audit.chain.checkpoint.value':
    'Sequence {seq} ({count} recent checkpoints listed by the server)',
  'audit.chain.worker.full': 'Worker, full check (daily)',
  'audit.chain.worker.incremental': 'Worker, incremental check (hourly)',
  'audit.chain.run.never': 'Not run yet',
  'audit.chain.run.succeeded': 'Succeeded',
  'audit.chain.run.failed': 'Failed ({code})',
  'audit.chain.run.skipped': 'Skipped',
  'audit.chain.run.notYet': 'No outcome yet',
  'audit.chain.run.next': 'Next run',
  'audit.chain.exports': 'Off-host export',
  'audit.chain.exports.none': 'No exporter is configured.',
  'audit.chain.exports.upToDate': '{kind}: up to date through sequence {seq}',
  'audit.chain.exports.behind':
    '{kind}: behind (last sequence {seq}, {pending} checkpoints pending)',
  'audit.chain.notPersisted':
    'The worker’s results are not kept beyond their outcome and time; the verdict above is computed for this read.',

  // ----- filters -----
  'audit.filter.title': 'Filter audit events',
  'audit.filter.actor': 'Actor',
  'audit.filter.actor.any': 'Anyone',
  'audit.filter.actor.self': 'Only me',
  'audit.filter.result': 'Outcome',
  'audit.filter.result.any': 'Any outcome',
  'audit.filter.action': 'Action',
  'audit.filter.action.hint': 'Such as migration.apply',
  'audit.filter.target': 'Target ID',
  'audit.filter.target.hint': 'A tgt_ ID',
  'audit.filter.client': 'Client ID',
  'audit.filter.client.hint': 'A cli_ ID',
  'audit.filter.grant': 'Grant ID',
  'audit.filter.grant.hint': 'A grt_ ID',
  'audit.filter.person': 'Person',
  'audit.filter.person.any': 'Any person',
  'audit.filter.person.human': '{name} (Person)',
  'audit.filter.person.service': '{name} (Service account)',
  'audit.filter.person.stateOption': '{name} ({state})',
  'audit.filter.person.noRead':
    'Choosing a person by name needs access.read. Enter the person ID instead.',
  'audit.filter.person.withSelf':
    'With “Only me” chosen, both filters apply: events match only if that person is you.',
  'audit.filter.identity': 'Person ID',
  'audit.filter.identity.hint': 'An idn_ ID',
  'audit.filter.targetChoice': 'Target',
  'audit.filter.targetChoice.any': 'Any target',
  'audit.filter.range': 'Time range',
  'audit.filter.quick': 'Quick ranges',
  'audit.filter.quick.hour': 'Last hour',
  'audit.filter.quick.sixHours': 'Last 6 hours',
  'audit.filter.quick.day': 'Last 24 hours',
  'audit.filter.quick.week': 'Last 7 days',
  'audit.filter.quick.month': 'Last 30 days',
  'audit.filter.from': 'From',
  'audit.filter.to': 'Until',
  'audit.filter.time.hint': 'Your local date and time. The search uses UTC.',
  'audit.filter.time.sent': 'Searched as {utc} (UTC).',
  'audit.filter.time.invalid': 'Enter a real date and time, such as 2026-10-13 09:00.',
  'audit.filter.range.invalid': 'The end must be after the start.',
  'audit.filter.invalid': 'This does not fit. Expected: {hint}.',
  'audit.filter.submit': 'Search audit events',
  'audit.filter.clear': 'Clear filters',

  // ----- events -----
  'audit.events.title': 'Audit events',
  'audit.events.what': 'Audit events',
  'audit.events.caption': 'Audit events, newest first',
  'audit.events.empty.title': 'No audit events yet',
  'audit.events.empty.body': 'The read succeeded and found no events.',
  'audit.events.all': 'All {count} matching events are shown.',
  'audit.events.some': '{count} events are shown. Older events match too.',
  'audit.events.older': 'Show older events',
  'audit.events.noneYet':
    'None of the newest events read so far matches. Older events may: the server reads the log in windows.',
  'audit.column.time': 'Time',
  'audit.column.actor': 'Actor',
  'audit.column.action': 'Action',
  'audit.column.target': 'Target',
  'audit.column.outcome': 'Outcome',
  'audit.column.details': 'Details',
  'audit.target.none': 'None',
  'audit.outcome.succeeded': 'Succeeded',
  'audit.outcome.failed': 'Failed',
  'audit.outcome.denied': 'Denied',
  'audit.phase.requested': 'Requested',
  'audit.phase.denied': 'Denied',
  'audit.phase.accepted': 'Accepted',
  'audit.phase.completed': 'Completed',
  'audit.phase.failed': 'Failed',
  'audit.phase.reconciled': 'Reconciled',
  'audit.actor.human': 'Person',
  'audit.actor.service': 'Service account',
  'audit.actor.system': 'ExponetDB',

  // ----- details -----
  'audit.details.title': 'Event details',
  'audit.details.show': 'Details',
  'audit.details.open': 'Show details of event {id}',
  'audit.details.close': 'Close details',
  'audit.details.empty': 'Choose an event to see its details.',
  'audit.details.none': 'None',
  'audit.details.id': 'Event ID',
  'audit.details.time': 'Time',
  'audit.details.action': 'Action',
  'audit.details.phase': 'Phase',
  'audit.details.outcome': 'Outcome',
  'audit.details.actor': 'Actor',
  'audit.details.client': 'Client',
  'audit.details.clientKind': 'Through {kind}',
  'audit.details.grant': 'Grant {id}',
  'audit.details.target': 'Target',
  'audit.details.cluster': 'Cluster',
  'audit.details.node': 'Node',
  'audit.details.reason': 'Reason',
  'audit.details.denial': 'Denial',
  'audit.details.planHash': 'Plan hash',
  'audit.details.job': 'Node job',
  'audit.details.links': 'Related pages',
  'audit.details.link.plan': 'Open plan',
  'audit.details.link.operation': 'Open operation',
  'audit.details.link.ledger': 'Open migrations ledger',

  // ----- export -----
  'audit.export.section': 'Export',
  'audit.export.title': 'Export audit events for offline verification',
  'audit.export.notPermitted':
    'Exporting needs the permission policy.manage, which owners and administrators hold. You can search and read events here.',
  'audit.export.personal.title': 'The file holds full events with personal data',
  'audit.export.personal.body':
    'Each event is exported exactly as stored: names, request pseudonyms, client names, reasons and changes (OD-8). Store the file encrypted, keep it no longer than the audit retention allows, and do not attach it to tickets. Each export is itself audited with its range and count.',
  'audit.export.verify.intro':
    'The file is NDJSON: a header line, then one line per event in ascending sequence. To verify it without ExponetDB:',
  'audit.export.verify.step1':
    'For each event line, compute the RFC 8785 (JCS) form of its event and the SHA-256 input the ac1 chain defines from prevHash and that form.',
  'audit.export.verify.step2':
    'Check that the result, prefixed sha256:ac1:, equals the line’s hash, and that each prevHash equals the previous line’s hash.',
  'audit.export.verify.step3':
    'Anchor the first line: its prevHash must match a known checkpoint (the header lists them), the last line of the previous part, or the genesis value.',
  'audit.export.verify.step4':
    'Stop at the first failure and note its sequence. Continue with the next part while the header says more events follow.',
  'audit.export.verify.doc':
    'The exact procedure is in the ExponetDB documentation: exponetdb-docs/02-control-plane/audit.md, section 5.1 "Export for offline verification".',
  'audit.export.from': 'From (optional)',
  'audit.export.to': 'Until (optional)',
  'audit.export.bound.hint':
    'A sequence number or a UTC time such as 2026-10-13T09:00:00Z; included.',
  'audit.export.bound.hintTo': 'A sequence number or a UTC time; not included.',
  'audit.export.bound.invalid':
    'Enter a sequence number or a UTC time such as 2026-10-13T09:00:00Z.',
  'audit.export.submit': 'Download audit export',
  'audit.export.next': 'Download the next part',
  'audit.export.done': 'Downloaded {count} events, sequence {first} through {last}.',
  'audit.export.done.empty': 'Downloaded. No event falls in this range.',
  'audit.export.unreadable':
    'The server sent an export whose header the page cannot read. Nothing was saved. Try again.',
} as const satisfies Readonly<Record<string, string>>
