/**
 * Messages of the settings pages (`src/features/settings/`): products,
 * environments, policies (the data-read policy per tier first), installation
 * and its health, notifications (OD-21) and break-glass (list, review and
 * the banner; activation stays refused while OD-21 is open).
 */
export const settingsMessages = {
  'settings.registry.missing':
    'You can see this. Changing it needs the permission registry.manage; every change is a plan.',
  'settings.slug': 'Slug',
  'settings.slug.hint':
    'Lower-case letters, digits and hyphens, starting with a letter; at most 39.',
  'settings.slug.invalid': 'Use lower-case letters, digits and hyphens, starting with a letter.',
  'settings.displayName': 'Display name',
  'settings.displayName.invalid': 'Enter 1 to 120 characters without control characters.',
  'settings.rank.hint': 'Order of the environment from 0 to 1000; lower comes first.',
  'settings.rank.invalid': 'Enter a whole number from 0 to 1000.',
  'settings.tier.prod': 'Production',
  'settings.tier.nonprod': 'Non-production',

  // ----- products -----
  'settings.products.title': 'Products',
  'settings.products.description':
    'The products of the registry: the first part of every target path. A new product is a plan.',
  'settings.products.list': 'Products',
  'settings.products.what': 'Product list',
  'settings.products.caption': 'Products of the registry',
  'settings.products.more':
    'Only the first {count} products are shown. Others exist but are not listed here.',
  'settings.products.empty.title': 'No products yet',
  'settings.products.empty.body': 'The read succeeded and found no products.',
  'settings.products.column.name': 'Name',
  'settings.products.column.slug': 'Slug',
  'settings.products.column.id': 'Product ID',
  'settings.products.create.title': 'Add a product',
  'settings.products.create.description':
    'This creates a plan. Nothing exists until the plan is approved and applied; its review page opens next.',
  'settings.products.create.submit': 'Create plan to add product',

  // ----- projects -----
  'settings.projects.title': 'Projects',
  'settings.projects.description':
    'The projects of each product: the second part of every target path, with the schemas a fingerprint and a drift check cover. A new project and every change are plans.',
  'settings.projects.list': 'Projects',
  'settings.projects.what': 'Project list',
  'settings.projects.more':
    'Only the first {count} projects are shown. Others exist but are not listed here.',
  'settings.projects.empty.title': 'No projects yet',
  'settings.projects.empty.body':
    'The read succeeded and found no projects. A target needs a project, so add one below.',
  'settings.projects.revision': 'Revision {revision}',
  'settings.projects.scope': 'Managed schemas',
  'settings.projects.scope.all': 'Every schema except the system schemas',
  'settings.projects.scope.include': 'Only',
  'settings.projects.scope.exclude': 'Excluded:',
  'settings.projects.scope.include.label': 'Included schemas',
  'settings.projects.scope.include.hint':
    'One schema name per line. Leave it empty to cover every schema except the system schemas.',
  'settings.projects.scope.exclude.label': 'Excluded schemas',
  'settings.projects.scope.exclude.hint':
    'One schema name per line. pg_catalog, information_schema and exponetdb are always excluded.',
  'settings.projects.scope.invalid':
    'Use 1 to 63 characters per name without control characters, and at most 256 names.',
  'settings.projects.evidence': 'Evidence chain',
  'settings.projects.evidence.follows': 'Follows the evidence chain of its product',
  'settings.projects.evidence.skipped': 'Skips the evidence chain for',
  'settings.projects.edit': 'Edit project',
  'settings.projects.edit.hide': 'Hide the form',
  'settings.projects.edit.form': 'Change project {path}',
  'settings.projects.edit.submit': 'Create project change plan',
  'settings.projects.edit.noChange':
    'Nothing changed yet. Change a field to see what the plan would do.',
  'settings.projects.diff.title': 'What the plan would change',
  'settings.projects.diff.caption': 'Fields of project {path} that the plan would change',
  'settings.projects.diff.column.field': 'Field',
  'settings.projects.diff.column.before': 'Now',
  'settings.projects.diff.column.after': 'After the plan',
  'settings.projects.diff.name': 'Display name',
  'settings.projects.diff.include': 'Included schemas',
  'settings.projects.diff.exclude': 'Excluded schemas',
  'settings.projects.diff.allSchemas': 'Every schema except the system schemas',
  'settings.projects.diff.nothing': 'None',
  'settings.projects.diff.note':
    'This is what you typed against what the registry holds now. The plan review shows what the server decides, including how much approval the change needs.',
  'settings.projects.create.title': 'Add a project',
  'settings.projects.create.description':
    'This creates a plan. Nothing exists until the plan is approved and applied; its review page opens next.',
  'settings.projects.create.product': 'Product',
  'settings.projects.create.product.placeholder': 'Choose a product',
  'settings.projects.create.product.required': 'Choose a product.',
  'settings.projects.create.product.none':
    'No product is registered, so there is nothing to add a project to.',
  'settings.projects.create.product.link': 'Add a product',
  'settings.projects.create.product.hint':
    'The product is the first part of every target path of the project.',
  'settings.projects.create.submit': 'Create project plan',

  // ----- environments -----
  'settings.environments.title': 'Environments',
  'settings.environments.description':
    'The environments of each product: their tier, their order and the evidence a change needs before it reaches them. Production is its own tier.',
  'settings.environments.what': 'Environment list',
  'settings.environments.more':
    'Only the first {count} environments are shown. Others exist but are not listed here.',
  'settings.environments.empty.title': 'No environments yet',
  'settings.environments.empty.body':
    'The read succeeded and found no environments for this product.',
  'settings.environments.chain': 'Evidence chain',
  'settings.environments.chain.none': 'No environment takes evidence from another.',
  'settings.environments.evidence': 'Evidence from',
  'settings.environments.evidence.from': 'Needs verified evidence from {slug}',
  'settings.environments.evidence.none': 'Needs no evidence',
  'settings.environments.evidence.noneOption': 'No evidence needed',
  'settings.environments.rank': 'Order {rank}',
  'settings.environments.rankLabel': 'Order',
  'settings.environments.revision': 'Revision {revision}',
  'settings.environments.tier': 'Tier',
  'settings.environments.tier.hint': 'Production gets its own scopes, approvals and frame.',
  'settings.environments.tier.prodNote':
    'Production: changes here need verified evidence and, from agents, a human approval. The plan’s review shows what this tier change affects.',
  'settings.environments.edit': 'Change',
  'settings.environments.edit.hide': 'Close',
  'settings.environments.edit.form': 'Change environment {slug}',
  'settings.environments.edit.submit': 'Create plan to change environment',
  'settings.environments.edit.noChange': 'Nothing was changed. Change a field first.',
  'settings.environments.create.title': 'Add an environment',
  'settings.environments.create.submit': 'Create plan to add environment',

  // ----- policies -----
  'settings.policies.title': 'Policies',
  'settings.policies.description':
    'The rules every plan and request is checked against, their defaults and the settings in effect. A change is a plan; its review shows whether it lowers safety, which only an owner may plan.',
  'settings.policies.what': 'Policy settings',
  'settings.policies.empty.title': 'No policy rules',
  'settings.policies.empty.body': 'The read succeeded and listed no rules.',
  'settings.policies.manage.missing':
    'You can see the rules. Changing a setting needs the permission policy.manage.',
  'settings.policies.rules': 'Other rules',
  'settings.policies.state.changed': 'Changed',
  'settings.policies.state.default': 'Default',
  'settings.policies.version': 'Version {version}',
  'settings.policies.appliesTo': 'Applies to: {kinds}',
  'settings.policies.defaults': 'Defaults',
  'settings.policies.settings': 'Settings in effect',
  'settings.policies.settings.none': 'None. The defaults apply.',
  'settings.policies.revision': 'Revision {revision}',
  'settings.policies.severity.deny': 'Refuses',
  'settings.policies.severity.require': 'Requires',
  'settings.policies.severity.warn': 'Warns',
  'settings.policies.change': 'Change the installation setting',
  'settings.policies.change.hide': 'Close',
  'settings.policies.params': 'Parameters of {rule} (JSON object)',
  'settings.policies.params.hint':
    'Only the parameters the rule declares, with the type of its default. The server refuses anything else.',
  'settings.policies.params.invalid':
    'Enter a JSON object whose names start with a letter, such as {"mode": "by_tier"}.',
  'settings.policies.plan': 'Create plan to change setting',
  'settings.policies.scope': 'Applies to',
  'settings.policies.scope.hint': 'The installation, or one target (its own setting wins there).',
  'settings.policies.scope.installation': 'The whole installation',
  'settings.policies.scope.target': '{path} ({tier})',
  'settings.policies.scope.targetsFailed':
    'The targets could not be read ({reason}); only the installation can be chosen now.',
  'settings.policies.dataRead.title': 'Data reads by tier',
  'settings.policies.dataRead.description':
    'Who may read rows of a target (OD-13). An agent is every caller that is not a person in the Web App or the first-party CLI: an MCP client, a service account, an API key, CI. No scope lifts this rule.',
  'settings.policies.dataRead.missing': 'This installation reports no data.read rule.',
  'settings.policies.dataRead.invalid':
    'The installation’s data.read setting is not valid. The rule refuses every data read until it is fixed.',
  'settings.policies.dataRead.current': 'At the installation: {mode}.',
  'settings.policies.dataRead.caption': 'Who reads rows on each tier',
  'settings.policies.dataRead.tier': 'Tier',
  'settings.policies.dataRead.who': 'Who reads rows',
  'settings.policies.dataRead.who.all': 'People and agents',
  'settings.policies.dataRead.who.people': 'People only',
  'settings.policies.dataRead.who.nobody': 'Nobody',
  'settings.policies.dataRead.label.by_tier': 'By tier',
  'settings.policies.dataRead.label.enabled': 'Everyone',
  'settings.policies.dataRead.label.humans_only': 'People only',
  'settings.policies.dataRead.label.disabled': 'Nobody',
  'settings.policies.dataRead.mode.by_tier':
    'People read every tier; agents read non-production only. An unknown tier counts as production.',
  'settings.policies.dataRead.mode.enabled': 'People and agents read every tier.',
  'settings.policies.dataRead.mode.humans_only': 'People read rows; agents read none.',
  'settings.policies.dataRead.mode.disabled': 'Nobody reads rows.',
  'settings.policies.dataRead.modeLabel': 'Who reads rows',
  'settings.policies.dataRead.masked': 'Masked columns',
  'settings.policies.dataRead.masked.none': 'None. Values show to whoever may read rows.',
  'settings.policies.dataRead.targets': 'Targets with their own setting',
  'settings.policies.dataRead.targets.none': 'None. Every target follows the installation.',
  'settings.policies.dataRead.inherits': 'Masked columns only; the mode follows the installation',
  'settings.policies.dataRead.change': 'Change who reads rows',
  'settings.policies.dataRead.prodTarget': 'This target is production.',
  'settings.policies.dataRead.columns': 'Masked columns (one per line)',
  'settings.policies.dataRead.columns.hint':
    'One pattern schema.table.column per line, where * matches a name part; at most 256. Values are masked for anyone without data.read_sensitive.',
  'settings.policies.dataRead.columns.invalid':
    'This line does not fit schema.table.column: {line}',

  // ----- installation -----
  'settings.installation.title': 'Installation',
  'settings.installation.description':
    'This installation of ExponetDB and the health of its Control Plane. What this release cannot observe is listed as such, never counted as operational.',
  'settings.installation.about': 'About this installation',
  'settings.installation.what': 'Installation details',
  'settings.installation.id': 'Installation ID',
  'settings.installation.id.none': 'Not reported',
  'settings.installation.version': 'Version',
  'settings.installation.contracts': 'Contract versions',
  'settings.installation.features': 'Enabled features',
  'settings.installation.features.none': 'None reported',
  'settings.installation.health': 'Control Plane health',
  'settings.installation.health.what': 'Control Plane health',
  'settings.installation.overall': 'Overall:',
  'settings.installation.overall.partial':
    'Components not observed and not part of this state: {count}.',
  'settings.installation.state.operational': 'Operational',
  'settings.installation.state.degraded': 'Degraded',
  'settings.installation.state.down': 'Down',
  'settings.installation.source': 'Source: {source}.',
  'settings.installation.reasons': 'Reasons: {reasons}',
  'settings.installation.unobserved': 'Not observed',
  'settings.installation.unobserved.none': 'Every component is observed.',
  'settings.installation.unobserved.item': '{component}: not observed ({reason})',

  // ----- notifications -----
  'settings.notifications.title': 'Notifications',
  'settings.notifications.description':
    'Where ExponetDB sends invitations and security notifications.',
  'settings.notifications.what': 'Notification channels',
  'settings.notifications.consequences':
    'Until a channel exists, invitation links are passed on by the person who invites, and break-glass activation is refused because the owners could not be notified.',

  // ----- break-glass -----
  'settings.breakGlass.title': 'Break-glass',
  'settings.breakGlass.description':
    'Time-boxed overrides of named rules on one target, each with a reason, and their post-incident review. A review is recorded once and kept for good.',
  'settings.breakGlass.activation': 'Activating break-glass',
  'settings.breakGlass.activation.reason':
    'It stays refused until the owner decides the notification channel (OD-21), because the owners must be notified of every activation.',
  'settings.breakGlass.list': 'Break-glass grants',
  'settings.breakGlass.what': 'Break-glass grants',
  'settings.breakGlass.more':
    'Only the first {count} grants are shown. Others exist but are not listed here.',
  'settings.breakGlass.empty.title': 'No break-glass grants',
  'settings.breakGlass.empty.body': 'The read succeeded and found no grants with this filter.',
  'settings.breakGlass.filter': 'Show',
  'settings.breakGlass.filter.all': 'All grants',
  'settings.breakGlass.filter.open': 'Review open',
  'settings.breakGlass.filter.done': 'Reviewed',
  'settings.breakGlass.target': 'Target',
  'settings.breakGlass.grant': 'Grant ID',
  'settings.breakGlass.activatedBy': 'Activated by',
  'settings.breakGlass.timeBox': 'Time box',
  'settings.breakGlass.until': 'Until',
  'settings.breakGlass.usesLabel': 'Uses',
  'settings.breakGlass.uses': '{uses} of {max} uses',
  'settings.breakGlass.uses.unlimited': '{uses} uses, no limit',
  'settings.breakGlass.rules': 'Overridden rules',
  'settings.breakGlass.revoked': 'Revoked',
  'settings.breakGlass.reason': 'Reason given at activation',
  'settings.breakGlass.state.active': 'Active',
  'settings.breakGlass.state.expired': 'Ended (time box)',
  'settings.breakGlass.state.revoked': 'Revoked',
  'settings.breakGlass.state.used_up': 'Ended (uses)',
  'settings.breakGlass.review.open': 'Review open',
  'settings.breakGlass.review.badgeDone': 'Reviewed',
  'settings.breakGlass.review.title': 'Review',
  'settings.breakGlass.review.by': 'Reviewed by',
  'settings.breakGlass.review.record': 'Record the post-incident review',
  'settings.breakGlass.review.note': 'Review note',
  'settings.breakGlass.review.warning':
    'This note is kept permanently with the grant and can never be changed or erased. Do not enter personal data. 1 to {max} characters.',
  'settings.breakGlass.review.count': '{count} of {max} characters',
  'settings.breakGlass.review.stillActive':
    'This grant is still active. The server accepts a review only after its time box ends, its uses run out or it is revoked, and refuses it until then.',
  'settings.breakGlass.review.submit': 'Record review',
  'settings.breakGlass.review.confirm.title': 'Record this review permanently',
  'settings.breakGlass.review.confirm.body':
    'The note below is stored with the grant for good. A grant is reviewed once; nobody can change or remove the note afterwards.',
  'settings.breakGlass.review.confirm.action': 'Record review',
  'settings.breakGlass.review.done': 'Review recorded.',
  'settings.breakGlass.note.blank': 'Enter a note. A note of spaces only is refused.',
  'settings.breakGlass.note.long': 'Use at most {max} characters.',
  'settings.breakGlass.note.characters':
    'Remove control characters and direction overrides; line breaks are fine.',
  'settings.breakGlass.banner.title': 'Break-glass grants waiting for their review: {count}',
  'settings.breakGlass.banner.titleMore':
    'Break-glass grants waiting for their review: at least {count}',
  'settings.breakGlass.banner.activeOnly': 'Break-glass grants active now: {count}',
  'settings.breakGlass.banner.body':
    'Each grant that ended needs a post-incident review by an owner or administrator.',
  'settings.breakGlass.banner.alsoActive': 'Still active, to be reviewed after they end: {count}.',
  'settings.breakGlass.banner.link': 'Review break-glass grants',
  'settings.breakGlass.banner.failed':
    'Could not read whether break-glass grants wait for review: {reason} This does not mean none do.',
} as const satisfies Readonly<Record<string, string>>
