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
  'schema.selector.more': '{count} more schemas exist. Use the name filter to reach their objects.',

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
} as const
