/**
 * Messages of the SQL workspace (`src/features/sql/`): the two modes, query
 * tabs, run, EXPLAIN and cancel, the live classification, the migration
 * draft, the history and the saved queries.
 */
export const sqlMessages = {
  // Modes and the toolbar.
  'sql.mode.label': 'Mode',
  'sql.mode.query': 'Query',
  'sql.mode.draft': 'Draft a change',
  'sql.mode.queryHint':
    'Query mode runs one read-only statement on this target when you press Run. The server decides whether you may read here.',
  'sql.mode.draftHint':
    'Draft mode never runs anything. The server classifies the text as you type; Create migration turns it into a bundle draft whose plan you review before anything is applied.',
  'sql.run.run': 'Run',
  'sql.run.runSelected': 'Run selected',
  'sql.run.rowLimit': 'Row limit',
  'sql.run.rowLimitOption': '{count} rows',
  'sql.run.multiHint':
    'The text holds {count} statements. Run sends the statement under the cursor; select text to send only that.',
  'sql.run.scopeSelection': 'Sent the selected text.',
  'sql.run.scopeStatement': 'Sent statement {n} of {count}, which starts on line {line}.',
  'sql.run.heldSelection': 'The selected text was not sent.',
  'sql.run.heldStatement': 'Statement {n} of {count}, which starts on line {line}, was not sent.',
  'sql.run.explain': 'Explain',
  'sql.run.analyze': 'Include actual times (runs the query)',
  'sql.run.cancel': 'Cancel the query',
  'sql.production.query':
    'Production target: a read sees production data. Data reads on production may be limited to people by the target setting; the server says so if it refuses.',
  'sql.production.draft':
    'Production target: a plan from this draft needs the same change verified on the evidence environment first, and an approval where the policy asks for one.',

  // Tabs.
  'sql.tabs.label': 'Query tabs',
  'sql.tabs.new': 'New tab',
  'sql.tabs.newQuery': 'New query',
  'sql.tabs.newDraft': 'New draft',
  'sql.tabs.position': 'Tab {n}, {mode}:',
  'sql.tabs.close': 'Close tab {n}',

  // The editor.
  'sql.editor.what': 'SQL editor',
  'sql.editor.labelQuery': 'SQL query',
  'sql.editor.labelDraft': 'SQL draft of a change',
  'sql.editor.placeholderQuery': 'Write one read-only statement, then press Run.',
  'sql.editor.placeholderDraft': 'Write the change as SQL. Nothing runs from here.',
  'sql.editor.hiddenNote':
    'Hidden and direction characters are shown as code points in the editor.',
  'sql.completion.detail': 'In {schema}: {kind}',

  // Where a tab's text came from.
  'sql.note.dismiss': 'Dismiss',
  'sql.link.title': 'Opened from a link, not run',
  'sql.link.body':
    'A link put this text here. Nothing was run. Read all of it before you run or draft it: a link can hide a statement far down the text.',
  'sql.link.size': '{lines} lines, {characters} characters.',
  'sql.link.hidden':
    'The text holds {count} hidden, control or direction characters. The editor shows each one as its code point.',
  'sql.link.tooLongTitle': 'Link text not opened',
  'sql.link.tooLong':
    'The text in the link has {length} characters, more than the {max} a link may open. It was not opened and not run.',
  'sql.history.openedTitle': 'Opened from your history, not run',
  'sql.history.openedBody':
    'This is the redacted statement the audit kept: constants are replaced and it is cut at 256 characters, so it may not run as it is.',
  'sql.template.openedTitle': 'From a template, not run',
  'sql.template.openedBody':
    'This text is a starting point. Nothing was run. Change the names to match your schema and read all of it before you run or draft it.',
  'sql.saved.openedTitle': 'Opened from a saved query, not run',
  'sql.saved.openedBody':
    'Saved text is data like any other text. Read it before you run it; the server checks a read of it like any read.',

  // The result.
  'sql.result.title': 'Result',
  'sql.result.what': 'Query result',
  'sql.result.idle': 'Run a query to see its result here. Nothing runs until you press Run.',
  'sql.result.meta': '{rows} rows in {ms} ms.',
  'sql.result.truncatedRows':
    'The result was cut at the {cap} row limit. The rows shown are not all the rows.',
  'sql.result.truncatedBytes':
    'The result was cut at the {cap} byte limit. The rows shown are not all the rows.',
  'sql.result.truncatedUnknown': 'The server cut the result. The rows shown are not all the rows.',
  'sql.result.truncatedRaise': 'Choose a higher row limit to read more rows.',
  'sql.result.truncatedLowered':
    'You asked for at most {requested} rows; the server limits this read to {cap}.',
  'sql.result.masked':
    '{count} columns are masked by the target setting: their values are hidden, not NULL.',
  'sql.result.rls':
    'Row-level security is enabled on {count} relations. The reader bypasses it, so this result is complete; application users see less.',
  'sql.result.gridLabel': 'Result of the last query',
  'sql.explain.what': 'Query plan',
  'sql.explain.totalCost': 'Total cost',
  'sql.explain.planRows': 'Estimated rows',
  'sql.explain.duration': 'Planning time',
  'sql.explain.ms': '{ms} ms',
  'sql.explain.seqScans': 'Sequential scans',
  'sql.explain.none': 'None',
  'sql.cancel.requested': 'Cancel requested. Waiting for the server.',
  'sql.cancel.canceled': 'The server canceled the query.',
  'sql.cancel.finished': 'The query had already finished when the cancel arrived.',
  'sql.cancel.failed': 'Could not cancel the query: {message} ({code})',

  // A failed run.
  'sql.error.sqlstate': 'PostgreSQL error code (SQLSTATE): {sqlstate}',
  'sql.error.copy': 'Copy error',
  'sql.error.copied': 'Copied the error code and message.',
  'sql.error.copyFailed': 'Could not copy. Select the text and copy it yourself.',
  'sql.error.clipboard': '{code}: {message}',
  'sql.error.clipboardSqlstate': '{code} (SQLSTATE {sqlstate}): {message}',

  // A write in Query mode.
  'sql.write.title': 'This text changes data or the schema',
  'sql.write.held':
    'The server classifies this text as a change, so Query mode does not send it. Nothing was run.',
  'sql.write.refused': 'The server refused the text as not read-only. Nothing was changed.',
  'sql.write.classes': 'Classes:',
  'sql.write.path':
    'Query mode runs one read-only statement. A change is drafted as a migration and goes through plan, apply and verify.',
  'sql.write.draft': 'Draft as migration',

  // Classification.
  'sql.class.title': 'How the server classifies this text',
  'sql.class.details': 'Show how the server classifies this text',
  'sql.class.what': 'Classification',
  'sql.class.idle': 'Write SQL to see how the server classifies it.',
  'sql.class.tooLarge':
    'Not classified: the text is longer than 64 KiB. Nothing is known about what it does.',
  'sql.class.failedNotSafe':
    'This does not mean the text is safe. Nothing is known about what it does until the server classifies it.',
  'sql.class.grammar': 'PostgreSQL {major} grammar.',
  'sql.class.empty': 'The text holds comments only. There is no statement to classify.',
  'sql.class.parseError': 'Syntax error at line {line}, column {column}.',
  'sql.class.parseErrorNoPosition': 'The text could not be parsed ({reason}).',
  'sql.class.parseErrorNotSafe':
    'A text that does not parse has no classification. That does not make it safe.',
  'sql.class.goToError': 'Go to the error',
  'sql.class.readPathAdmitted':
    'The whole text is one statement the read path admits. This is the parser only: the server still checks your permission, the tier and the target.',
  'sql.class.readPathRefused': 'Not admitted on the read path: {code} ({reason}).',
  'sql.class.readPathRefusedNoReason': 'Not admitted on the read path.',
  'sql.class.counts': '{count} statements.',
  'sql.class.listLabel': 'Statements',
  'sql.class.statement': 'Statement {n}, lines {from} to {to}',
  'sql.class.noClass':
    'No class: what it does cannot be derived from the text. This is not a statement that it is safe.',
  'sql.class.procedural':
    'It runs code the analysis cannot see into, so its effects are not known.',
  'sql.class.statementReadable': 'The read path admits this statement on its own.',
  'sql.class.statementNotReadable': 'The read path does not admit this statement.',
  'sql.class.statementRefused': 'The read path refuses it: {code} ({reason}).',
  'sql.class.migrationRefusal': 'A migration refuses this statement: {reason}.',
  'sql.class.excerpt': 'Statement text',
  'sql.class.goTo': 'Go to statement {n}',
  'sql.class.notAPromise':
    'Classes come from the server parser. A statement without a class, or a text that was not classified, is never safe by default.',
  'sql.diag.statement': 'Statement {n}: {label}. Classes: {classes}.',
  'sql.diag.noClass': 'None (not derivable, not safe by default)',
  'sql.diag.parseError': 'Syntax error: the parser stopped here.',

  // The migration draft.
  'sql.draft.create': 'Create migration',
  'sql.draft.title': 'Migration bundle draft',
  'sql.draft.intro':
    'The editor text is up.sql. Fill in the manifest, write the checks in verify.sql, check the bundle, then create a plan. Nothing is applied from this page.',
  'sql.draft.close': 'Close the draft',
  'sql.draft.name': 'Name',
  'sql.draft.nameHint':
    'Lower case words joined by hyphens, at most 64 characters: add-orders-index.',
  'sql.draft.nameInvalid':
    'Use lower case letters, digits and single hyphens between words, at most 64 characters.',
  'sql.draft.id': 'Migration id',
  'sql.draft.idHint':
    'A new ULID made in this browser. The order comes from the dependencies, not the id.',
  'sql.draft.description': 'Description',
  'sql.draft.dependsOn': 'Depends on',
  'sql.draft.dependsHint':
    'One migration id or baseline:<name> per line. Leave it empty for no dependency.',
  'sql.draft.dependsInvalid': '{count} lines are not a migration id or a baseline.',
  'sql.draft.compatibility': 'Declared compatibility',
  'sql.draft.transactional': 'Run in one transaction',
  'sql.draft.nonTxHint':
    'The server marks a statement as non-transactional. The lint refuses it in a transactional bundle.',
  'sql.draft.notes': 'Compatibility notes',
  'sql.draft.notesHint': 'Required unless the change is additive.',
  'sql.draft.notesNeeded':
    'Write why the change is safe to roll out; it is required for this class.',
  'sql.draft.verifyTitle': 'Checks after apply (verify.sql)',
  'sql.draft.verifyHint':
    'Generated here as a skeleton. Every check fails until you replace it with a real one, so a skeleton never verifies a change.',
  'sql.draft.verifyReset': 'Generate the skeleton again',
  'sql.draft.verifyLabel': 'Checks of the draft (verify.sql)',
  'sql.draft.manifestTitle': 'Show migration.yaml',
  'sql.draft.copyManifest': 'Copy migration.yaml',
  'sql.draft.copyUp': 'Copy up.sql',
  'sql.draft.copyVerify': 'Copy verify.sql',
  'sql.draft.copied': 'Copied to the clipboard.',
  'sql.draft.copyFailed': 'Could not copy. Select the text and copy it yourself.',
  'sql.draft.check': 'Check the bundle',
  'sql.draft.plan': 'Create plan',
  'sql.draft.planTitle': 'Create a migration plan',
  'sql.draft.planBody':
    'The server checks the bundle again and creates a plan for this target. Nothing is applied: you review the plan, and applying it is a separate step.',
  'sql.draft.planAction': 'Create plan',
  'sql.draft.incomplete':
    'Fill in the name, the description and, unless the change is additive, the notes.',
  'sql.lint.what': 'Lint result',
  'sql.lint.title': 'Lint result',
  'sql.lint.failedNote': 'This does not mean the bundle passed the lint.',
  'sql.lint.outdated': 'The draft changed after this check. Check the bundle again.',
  'sql.lint.none': 'The lint found nothing.',
  'sql.lint.count': '{count} findings, {blocking} of them blocking.',
  'sql.lint.graphError': 'Dependency graph error: {code}.',
  'sql.lint.finding': 'Level {level}, rule {rule}, file {file}: {blocking}',
  'sql.lint.blocking': 'Blocking',
  'sql.lint.notBlocking': 'Not blocking',
  'sql.lint.message': 'Lint message',

  // The side panel.
  'sql.side.label': 'Saved queries and history',
  'sql.list.more': 'Show more',
  'sql.history.title': 'History',
  'sql.history.what': 'Query history',
  'sql.history.note':
    'Your own reads of this target from the audit. Statements are redacted; opening one never runs it.',
  'sql.history.query': 'Query',
  'sql.history.explain': 'Explain',
  'sql.history.succeeded': 'Succeeded',
  'sql.history.failed': 'Failed',
  'sql.history.rows': '{rows} rows',
  'sql.history.ms': '{ms} ms',
  'sql.history.truncated': 'Cut at a limit',
  'sql.history.client': 'Through {client} ({caller})',
  'sql.history.statement': 'Redacted statement',
  'sql.history.open': 'Open in a new tab',
  'sql.saved.title': 'Saved',
  'sql.saved.what': 'Saved queries',
  'sql.saved.name': 'Saved query name',
  'sql.saved.personal': 'Only you',
  'sql.saved.project': 'Shared in the scope',
  'sql.saved.scopeTarget': 'This target',
  'sql.saved.scopeProject': 'The project',
  'sql.saved.yours': 'Yours',
  'sql.saved.someoneElse': 'Saved by someone else',
  'sql.saved.revision': 'Revision {revision}',
  'sql.saved.open': 'Open in a new tab',
  'sql.saved.delete': 'Delete',
  'sql.saved.deleteTitle': 'Delete the saved query',
  'sql.saved.deleteBody':
    'The saved query is removed for everyone who can see it. Open tabs keep their text.',
  'sql.saved.deleteAction': 'Delete saved query',

  // Saved query actions.
  'sql.saved.menu': 'Actions',
  'sql.tabs.savedMenu': 'Actions for the saved query in tab {n}',
  'sql.saved.menuRename': 'Rename',
  'sql.saved.menuVisibility': 'Who sees it',
  'sql.saved.menuPersonal': 'Only me',
  'sql.saved.menuShared': 'Shared in scope',
  'sql.saved.menuCopy': 'Save as copy',
  'sql.saved.copyName': '{name} (copy)',
  'sql.saved.renamed': 'Renamed. The saved query is at revision {revision}.',
  'sql.saved.nowPersonal': 'Only you can see this saved query now. Revision {revision}.',
  'sql.saved.nowShared':
    'Everyone who may read data in its scope can see this saved query now. Revision {revision}.',
  'sql.saved.copySaved': 'Saved a copy as a new query.',
  'sql.saved.changeFailedTitle': 'Could not change the saved query',
  'sql.rename.title': 'Rename the saved query',
  'sql.rename.description':
    'Renaming changes the name only. The stored text stays as it is and the scope never changes.',
  'sql.rename.submit': 'Rename saved query',
  'sql.rename.cancel': 'Cancel',
  'sql.save.copyTitle': 'Save a copy of the query',
  'sql.save.copyDescription':
    'The copy is a new saved query that you own. The original stays as it is. Saving never runs the text.',
  'sql.save.copySubmit': 'Save copy',

  // Templates.
  'sql.templates.title': 'Templates',
  'sql.templates.note':
    'Starting points for common work. Opening one puts its text in a new tab and never runs it.',
  'sql.templates.queryGroup': 'Queries',
  'sql.templates.draftGroup': 'Changes to draft',
  'sql.templates.open': 'Open in a new tab',
  'sql.template.version.title': 'PostgreSQL version',
  'sql.template.version.description': 'The version of PostgreSQL this target runs.',
  'sql.template.sessions.title': 'Active sessions by state',
  'sql.template.sessions.description':
    'How many client sessions are active, idle or waiting, from pg_stat_activity.',
  'sql.template.sizes.title': 'Table sizes',
  'sql.template.sizes.description':
    'The 50 largest tables and materialized views with their total size, indexes and TOAST included.',
  'sql.template.indexUsage.title': 'Index usage',
  'sql.template.indexUsage.description':
    'The 50 least scanned indexes since the statistics were last reset, from pg_stat_user_indexes.',
  'sql.template.extensions.title': 'Installed extensions',
  'sql.template.extensions.description':
    'The extensions created in this database and their versions.',
  'sql.template.longTransactions.title': 'Long-running transactions',
  'sql.template.longTransactions.description':
    'Open transactions, oldest first. Long ones hold back cleanup and can block schema changes.',
  'sql.template.createTable.title': 'Create a table',
  'sql.template.createTable.description':
    'A table with an identity key and a timestamp. Rename it and its columns first.',
  'sql.template.addColumn.title': 'Add a column',
  'sql.template.addColumn.description':
    'A nullable column without a default, which PostgreSQL adds without rewriting the table.',
  'sql.template.addIndex.title': 'Add an index concurrently',
  'sql.template.addIndex.description':
    'Builds the index without blocking writes. It cannot run in a transaction, so it needs a bundle of its own.',
  'sql.template.addCheck.title': 'Add a check constraint, not validated',
  'sql.template.addCheck.description':
    'Adds the constraint for new writes only, with a short lock. Validate it in a later migration.',
  'sql.template.validateCheck.title': 'Validate a check constraint',
  'sql.template.validateCheck.description':
    'Checks the existing rows against a constraint that was added as not valid, without blocking writes.',

  // Saving.
  'sql.save.open': 'Save query',
  'sql.save.update': 'Save changes',
  'sql.save.title': 'Save the query',
  'sql.save.description':
    'Saving keeps the text. It never runs it; running it later is an ordinary read.',
  'sql.save.name': 'Name',
  'sql.save.nameHint': 'One line, at most 120 characters, without hidden or direction characters.',
  'sql.save.nameTooLong': 'The name is longer than {max} characters.',
  'sql.save.visibility': 'Who sees it',
  'sql.save.personal': 'Only me',
  'sql.save.shared': 'Everyone who may read data in its scope',
  'sql.save.scope': 'Scope',
  'sql.save.scopeTarget': 'This target',
  'sql.save.scopeProject': 'The whole project',
  'sql.save.scopeHint': 'The scope never changes after saving.',
  'sql.save.cancel': 'Cancel',
  'sql.save.submit': 'Save query',
  'sql.save.done': 'Saved as revision {revision}.',
  'sql.save.failedTitle': 'Could not save the query',
  'sql.save.conflictTitle': 'The saved query changed',
  'sql.save.conflictBody':
    'Someone saved another revision after revision {revision}, which this tab is based on. Nothing was changed. Open the stored version or save your text as a new query.',
  'sql.save.openStored': 'Open the stored version',
  'sql.save.asNew': 'Save as a new query',
} as const satisfies Readonly<Record<string, string>>
