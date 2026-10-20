/**
 * Messages of the schema browser (`src/features/schema/`): fingerprint and
 * drift status, the schema overview and tree, the per-kind object lists, the
 * object detail and the diagram.
 */
export const schemaMessages = {
  'schema.yes': 'Yes',
  'schema.no': 'No',
  'schema.none': 'None',

  // Fingerprint, drift and the way to a change.
  'schema.status.title': 'Fingerprint and drift',
  'schema.fingerprint.what': 'Schema fingerprint',
  'schema.fingerprint.label': 'Fingerprint',
  'schema.fingerprint.canonicalizer': 'Canonicalizer',
  'schema.fingerprint.entries': 'Entries',
  'schema.fingerprint.pgMajor': 'PostgreSQL major version',
  'schema.fingerprint.observed': 'Observed',
  'schema.fingerprint.incomplete':
    'The snapshot is incomplete: some objects were not visible to the observer role, so the fingerprint covers only what was read.',
  'schema.visibility.gaps':
    '{gaps} attributes and {schemas} schemas were not visible to the observer role. Objects there are missing from this page; that does not mean they do not exist.',
  'schema.drift.what': 'Drift findings',
  'schema.drift.more': 'More drift findings exist than one read returns. The first are counted.',
  'schema.drift.link': 'Open drift',
  'schema.drift.none': 'No drift finding is open.',
  'schema.drift.open': '{count} drift findings are open.',
  'schema.drift.lastSeen': 'Newest finding last seen',
  'schema.drift.note':
    'These are the stored findings, not a new check. Run a drift check on the drift page.',
  'schema.draft.link': 'Draft a change',
  'schema.draft.hint':
    'This page only reads. A change starts as a draft migration on the SQL page and goes through plan, apply and verify.',

  // The name filter and the schema selector.
  'schema.search.label': 'Filter by name',
  'schema.search.apply': 'Show matching objects',
  'schema.search.hint':
    'The Control Plane lists schema objects by name search. Enter part of a name (1 to 128 characters).',
  'schema.selector.label': 'Schema',
  'schema.selector.all': 'All schemas',
  'schema.selector.search': 'Search schemas',
  'schema.selector.empty': 'No schema matches.',
  'schema.selector.managed': 'Managed by ExponetDB',
  'schema.selector.others': 'Other schemas',
  'schema.selector.shown': 'Showing the first {shown} of {total} schemas. Type to narrow the list.',
  'schema.selector.failed':
    'The list of schemas could not be read, so schemas cannot be chosen here. The name filter still works.',

  // The lists.
  'schema.list.idle':
    'Enter part of a name to list objects. Nothing is listed until you do, and that is not the same as having none.',
  'schema.list.empty': 'The read succeeded and found no object with that name.',
  'schema.list.noneInSchema': 'None of the objects read so far is in this schema.',
  'schema.list.more': 'More objects match than one page shows. Load more to read them.',
  'schema.list.loadMore': 'Load more objects',
  'schema.list.caption': 'Objects that match the filter',
  'schema.list.name': 'Name',
  'schema.list.schema': 'Schema',
  'schema.list.parent': 'Belongs to',
  'schema.list.kind': 'Kind',
  'schema.list.signature': 'Arguments',

  // One object.
  'schema.object.what': 'Object details',
  'schema.object.kind': 'Kind',
  'schema.object.name': 'Name',
  'schema.object.parent': 'Belongs to',
  'schema.object.owner': 'Owner',
  'schema.object.size': 'Size',
  'schema.object.sizeNone': 'Not reported for this kind of object',
  'schema.object.rls': 'Row level security',
  'schema.object.rls.off': 'Off',
  'schema.object.rls.enabled': 'On',
  'schema.object.rls.forced': 'On and forced for the owner',
  'schema.object.comment': 'Comment',
  'schema.hint.securityDefiner':
    'This function is SECURITY DEFINER and its header sets no search_path. A caller could make it resolve names to objects of their own. Check the definition.',
  'schema.hint.rlsNoPolicy':
    'Row level security is on and this table has no policy, so reads by roles that are subject to it return no rows.',
  'schema.hint.invalidIndex':
    '{count} indexes are not valid. A failed concurrent build leaves one behind; it costs writes and serves no reads.',
  'schema.hint.unvalidated':
    '{count} constraints are not validated: they hold for new rows only, not for rows that were already there.',
  'schema.columns.none': 'The read found no column.',
  'schema.columns.caption': 'Columns',
  'schema.columns.name': 'Column',
  'schema.columns.type': 'Type',
  'schema.columns.nullable': 'Nullable',
  'schema.columns.default': 'Default',
  'schema.columns.generated': 'Generated as',
  'schema.columns.identity': 'Identity: {kind}',
  'schema.constraints.none': 'The read found no constraint.',
  'schema.constraints.caption': 'Constraints',
  'schema.constraints.name': 'Constraint',
  'schema.constraints.type': 'Type',
  'schema.constraints.definition': 'Definition',
  'schema.constraints.validated': 'Validated',
  'schema.constraints.notValidated': 'Not validated',
  'schema.indexes.none': 'The read found no index.',
  'schema.indexes.caption': 'Indexes',
  'schema.indexes.name': 'Index',
  'schema.indexes.unique': 'Unique',
  'schema.indexes.valid': 'Valid',
  'schema.indexes.invalid': 'Invalid',
  'schema.indexes.definition': 'Definition',
  'schema.indexes.usageNote':
    'How often an index is used is not part of this read. Index usage arrives with the performance statistics in Wave 9.',
  'schema.policies.none': 'The read found no policy.',
  'schema.policies.caption': 'Policies',
  'schema.policies.name': 'Policy',
  'schema.policies.command': 'Applies to',
  'schema.policies.kind': 'Kind',
  'schema.policies.permissive': 'Permissive',
  'schema.policies.restrictive': 'Restrictive',
  'schema.policies.roles': 'Roles',
  'schema.policies.expressions': 'Expressions',
  'schema.policies.using': 'USING',
  'schema.policies.withCheck': 'WITH CHECK',
  'schema.grants.none': 'The read found no grant.',
  'schema.grants.caption': 'Privileges',
  'schema.grants.grantee': 'Grantee',
  'schema.grants.privileges': 'Privileges',
  'schema.definition.title': 'Definition',
  'schema.definition.note':
    'The text of the definition as the database holds it. It is data: it is shown, never run, and long text is shortened until you ask for all of it.',
  'schema.triggers.modeNote':
    'Whether a trigger is enabled, disabled or fires only for replicas is not part of this read yet.',

  // The kinds of object.
  'schema.nav.label': 'Kinds of schema object',
  'schema.nav.index': 'Overview',
  'schema.kind.schemas': 'Schemas',
  'schema.kind.tables': 'Tables',
  'schema.kind.views': 'Views',
  'schema.kind.materialized-views': 'Materialized views',
  'schema.kind.functions': 'Functions',
  'schema.kind.triggers': 'Triggers',
  'schema.kind.types': 'Types',
  'schema.kind.sequences': 'Sequences',
  'schema.kind.extensions': 'Extensions',
  'schema.kind.indexes': 'Indexes',
  'schema.kind.policies': 'Policies',
  'schema.kind.privileges': 'Privileges',
  'schema.kind.publications': 'Publications',
  'schema.kind.roles': 'Roles',
  'schema.kind.visualizer': 'Visualizer',
  'schema.roles.requires':
    'A cluster-level read of roles; the schema inventory of a database does not hold them',

  // The classes in the counts.
  'schema.class.schema': 'Schemas',
  'schema.class.table': 'Tables',
  'schema.class.foreign_table': 'Foreign tables',
  'schema.class.view': 'Views',
  'schema.class.materialized_view': 'Materialized views',
  'schema.class.function': 'Functions',
  'schema.class.trigger': 'Triggers',
  'schema.class.enum': 'Enum types',
  'schema.class.domain': 'Domains',
  'schema.class.composite_type': 'Composite types',
  'schema.class.range_type': 'Range types',
  'schema.class.sequence': 'Sequences',
  'schema.class.extension': 'Extensions',
  'schema.class.index': 'Indexes',
  'schema.class.policy': 'Policies',
  'schema.class.column': 'Columns',
  'schema.class.constraint': 'Constraints',
  'schema.class.rule': 'Rules',
  'schema.class.publication': 'Publications',
  'schema.class.event_trigger': 'Event triggers',

  // The overview and the tree.
  'schema.overview.title': 'Schemas and object counts',
  'schema.overview.what': 'Schemas',
  'schema.overview.empty': 'The read succeeded and found no schema.',
  'schema.overview.caption': 'Schemas with the number of objects of each class',
  'schema.overview.schema': 'Schema',
  'schema.overview.managed': 'Managed by ExponetDB',
  'schema.overview.managedYes': 'Yes',
  'schema.overview.managedNo': 'No',
  'schema.overview.objects': 'Objects',
  'schema.tree.title': 'Browse by schema',
  'schema.tree.label': 'Schemas and their objects',
  'schema.tree.filter': 'Filter the tree by name',
  'schema.tree.needsTerm':
    'Objects are listed by name search. Enter part of a name above and open this class again. This does not mean the class is empty.',
  'schema.tree.openKind': 'Open the full list of this kind',

  // The diagram.
  'schema.erd.what': 'Schema diagram',
  'schema.erd.filter': 'Draw the tables whose name contains',
  'schema.erd.idle':
    'Enter part of a table name to draw the matching tables with their foreign keys. At most 30 tables are drawn at once.',
  'schema.erd.capped': 'Drawing the first {shown} of {total} matching tables.',
  'schema.erd.undrawn':
    '{count} foreign keys are not drawn: they point at a table outside this filter, or their definition could not be read.',
  'schema.erd.unread': '{count} of {total} tables could not be read and are not drawn.',
  'schema.erd.moreMatch': 'More tables match than the search returned. Narrow the filter.',
  'schema.erd.stale': 'The list of tables is an earlier read.',
  'schema.erd.tools': 'Diagram tools',
  'schema.erd.find': 'Find a table',
  'schema.erd.find.search': 'Search tables',
  'schema.erd.find.empty': 'No table matches.',
  'schema.erd.find.shown': 'Showing the first {shown} of {total} tables. Type to narrow the list.',
  'schema.erd.focus.prefix': 'Focused on',
  'schema.erd.focus.suffix':
    'The diagram shows it with its {count} connected tables: the ones it references and the ones that reference it.',
  'schema.erd.focus.clear': 'Show all tables',
  'schema.erd.exportSvg': 'Download as SVG',
  'schema.erd.copyMarkdown': 'Copy as Markdown',
  'schema.erd.exported': 'Downloaded the {tables} tables drawn here as an SVG file.',
  'schema.erd.copiedMarkdown': 'Copied the {tables} tables drawn here as Markdown.',
  'schema.erd.copyFailed': 'Could not copy to the clipboard. Download the SVG instead.',
  'schema.erd.exportNote':
    'The exports hold the tables drawn here and the foreign keys between them, as read at the time shown.',

  // Tabs and actions of one object.
  'schema.tabs.label': 'Views of this object',
  'schema.tabs.details': 'Details',
  'schema.tabs.rows': 'Browse rows',
  'schema.actions.label': 'Actions for this object',
  'schema.actions.copyName': 'Copy name',
  'schema.actions.copyLink': 'Copy link',
  'schema.actions.copiedName': 'Copied the name.',
  'schema.actions.copiedLink': 'Copied the link.',
  'schema.actions.copyFailed':
    'Could not copy to the clipboard. Select the text and copy it yourself.',
  'schema.actions.queryTable': 'Query this table',
  'schema.actions.queryView': 'Query this view',
  'schema.actions.queryMaterializedView': 'Query this materialized view',
  'schema.actions.openDefinition': 'Open definition in SQL editor',
  'schema.actions.definitionTooLong':
    'The definition is too long to open from a link ({length} characters, at most {max}). Copy it from the definition below.',
  'schema.actions.draft': 'Draft a change to this object',
  'schema.actions.note':
    'These links open the SQL page with the text in a new tab. Nothing runs until you press Run there, and a change always goes through a draft.',

  // Key tokens and the jump along a foreign key.
  'schema.columns.keys': 'Keys',
  'schema.columns.keysNone': 'None',
  'schema.columns.pk': 'PK',
  'schema.columns.pk.long': 'Primary key',
  'schema.columns.uq': 'UQ',
  'schema.columns.uq.long': 'Unique',
  'schema.columns.uq.composite': 'Unique together with other columns',
  'schema.columns.fk': 'FK',
  'schema.columns.fk.long': 'Foreign key',
  'schema.columns.references': 'References',

  // The row browser.
  'schema.browse.what': 'Rows',
  'schema.browse.title': 'Rows of this object',
  'schema.browse.intro':
    'Reads one page of rows with a read-only SELECT. Every read is a data read: it is audited, sensitive columns are masked and the server decides what it admits. Nothing is read until you press Read rows.',
  'schema.browse.production': 'This is a production target. Each read is audited under your name.',
  'schema.browse.noColumns':
    'The schema read lists no column for this object, so no statement can be built. This does not mean the object has no rows.',
  'schema.browse.gate.what': 'Rows of this object',
  'schema.browse.off.title': 'Data reads are off for this target',
  'schema.browse.off.body':
    'The data-read setting of this target is disabled, so rows cannot be read here. This does not mean the object has no rows.',
  'schema.browse.off.link': 'Open the target configuration',
  'schema.browse.policyUnread':
    'Could not read the data-read setting of this target ({reason}). The server decides when you read.',
  'schema.browse.read': 'Read rows',
  'schema.browse.readAgain': 'Read again',
  'schema.browse.openSql': 'Open in SQL editor',
  'schema.browse.openSqlNote':
    'The editor gets the first page with the filter values written into the text. It opens and never runs.',
  'schema.browse.statement': 'The statement',
  'schema.browse.statementNote':
    'Filter values travel as parameters ($1 and on), not in the text. One more row than a page is asked for, to know whether there are more.',
  'schema.browse.refusal.no_columns': 'The schema read lists no column, so no statement was built.',
  'schema.browse.refusal.unquotable_name':
    'A name in the schema read cannot be written as a PostgreSQL identifier, so no statement was built.',
  'schema.browse.refusal.bad_cursor':
    'The place where the next page starts is not valid, so nothing was sent.',

  // Sort and filters.
  'schema.browse.filter.title': 'Filter rows',
  'schema.browse.filter.column': 'Column',
  'schema.browse.filter.choose': 'Choose a column',
  'schema.browse.filter.operator': 'Operator',
  'schema.browse.filter.value': 'Value',
  'schema.browse.filter.add': 'Add filter',
  'schema.browse.filter.remove': 'Remove filter',
  'schema.browse.filter.none': 'No filter. All rows of the object are read, a page at a time.',
  'schema.browse.filter.list': 'Filters, all of which must hold',
  'schema.browse.filter.max': 'At most {max} filters.',
  'schema.browse.filter.ilikeHint': 'Use % for any text and _ for one character.',
  'schema.browse.filter.ignoredTag': 'Ignored',
  'schema.browse.filter.ignored.unknown_column':
    'This column is not in the object, so the filter is ignored.',
  'schema.browse.filter.ignored.bad_operator':
    'This operator is not allowed, so the filter is ignored.',
  'schema.browse.filter.ignored.bad_value': 'This value is not valid, so the filter is ignored.',
  'schema.browse.filter.ignored.too_many':
    'There are more filters than the browser takes, so this one is ignored.',
  'schema.browse.sort.by': 'Sorted by',
  'schema.browse.sort.asc': 'Ascending',
  'schema.browse.sort.desc': 'Descending',
  'schema.browse.sort.clear': 'Clear sort',
  'schema.browse.sort.ignored':
    'The sort in the link is not a column of this object and is ignored.',
  'schema.op.eq': 'Is equal to',
  'schema.op.ne': 'Is not equal to',
  'schema.op.lt': 'Is less than',
  'schema.op.le': 'Is at most',
  'schema.op.gt': 'Is greater than',
  'schema.op.ge': 'Is at least',
  'schema.op.isNull': 'Is null',
  'schema.op.isNotNull': 'Is not null',
  'schema.op.ilike': 'Matches, ignoring case',

  // Order, paging and what a result says about itself.
  'schema.browse.order.primary_key': 'Ordered by the primary key.',
  'schema.browse.order.sort': 'Ordered by the sort you chose.',
  'schema.browse.order.none':
    'This object has no primary key and no sort is chosen, so the order of rows is not defined. Pages may repeat or skip rows.',
  'schema.browse.paging.keyset':
    'More rows continue after the last key value, so pages do not shift.',
  'schema.browse.paging.offset':
    'More rows are read with an offset, so rows may shift between pages if the data changes.',
  'schema.browse.paging.fellBack':
    'The key value of the last row could not be sent back (it is masked, cut or missing), so the next page uses an offset and rows may shift.',
  'schema.browse.meta': '{rows} rows read in {ms} ms, {total} loaded so far.',
  'schema.browse.truncation.rows': 'The {cap} row limit',
  'schema.browse.truncation.bytes': 'The {cap} byte limit',
  'schema.browse.truncation.unknown': 'A limit of the server',
  'schema.browse.masked':
    '{count} columns are masked by the server: their values are hidden, not empty.',
  'schema.browse.rls':
    'The reader bypasses row level security, so these rows are complete. Row level security is on for {count} relations in this read, so applications see fewer rows.',
  'schema.browse.partialMissing': 'Only the first {count} rows are read; more rows exist.',
  'schema.browse.limit': 'The browser stops at {max} loaded rows. Add a filter to narrow the rows.',
  'schema.browse.gridLabel': 'Rows of the object',
  'schema.browse.loadMoreFailed':
    'Could not read the next rows: {message} ({code}). The rows above are still the ones that were read.',
  'schema.browse.retryMore': 'Try again',
  'schema.browse.refused.title': 'The server refused this read',
  'schema.browse.refused.body': 'Nothing was read. This is not an empty table.',
} as const
