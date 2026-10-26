/** Messages of the target layout (`src/features/target/`). */
export const targetMessages = {
  'target.read.what': 'Target',
  'target.health.what': 'Target health',
  'target.feature.default': 'This page',
  'target.bar.label': 'Target',
  'target.bar.environment': 'Environment',
  'target.tier.unknown': 'Tier unknown',
  'target.nav.label': 'Target sections',
  'target.commands.section': 'Switch environment',
  'target.command.switch': 'Switch to {environment}',
  'target.switcher.loading': 'Loading environments',
  'target.switcher.failed':
    'Could not read the environments of this project: {reason} This does not mean there are no other environments.',
  'target.switcher.empty': 'The read succeeded and found no environments for this project.',
  'target.switcher.stale': 'Showing an earlier read of the environments, observed',
  'target.switcher.partial': 'Showing part of the environments. {missing}',
  'target.switcher.missing.more': 'More environments exist than one read returns.',
  'target.switcher.missing.unreadable': 'Some environments have a path the page cannot show.',
  'target.switcher.projectHome': 'Project overview',
  'target.switcher.current': 'Current environment',
  // The database switcher of the context bar and the "Switch database" command page.
  'target.switch.trigger': 'Switch database',
  'target.switch.search': 'Search databases',
  'target.switch.recent': 'Recent',
  'target.switch.current': 'Current database',
  'target.switch.loading': 'Loading databases',
  'target.switch.failed':
    'Could not read the databases: {reason} This does not mean there are no other databases.',
  'target.switch.empty': 'The read succeeded and found no databases.',
  'target.switch.stale': 'Showing an earlier read of the databases, observed',
  'target.switch.partial': 'Showing part of the databases. {missing}',
  'target.switch.missing.more':
    'More databases exist than one read returns. Open the Databases page for the rest.',
  'target.switch.missing.unreadable': 'Some databases have a path the page cannot show.',
  'target.switch.noMatch': 'No database matches your search.',
  'target.switch.noMatchPartial':
    'No database in this part of the list matches your search. Others may exist.',
  'target.switch.page': 'Switch database',
  'target.switch.command': 'Switch database…',
  // Commands for the sections of the target the person is on.
  'target.command.goTo': 'Go to {section}',
  'target.command.schemaKind': 'Schema: {kind}',
  'target.command.query': 'Query the database',
  'target.command.draft': 'Draft a change',
  'target.command.notAvailable': 'Not available yet',
  // The health chip of the context bar.
  'target.health.label': 'Health',
  'target.health.notRead': 'Health not read',
  'target.health.notReadWhy':
    'The target could not be read, so ExponetDB cannot tell its health. This does not mean it is unhealthy.',
  'target.health.stale': 'Health out of date',
  'target.health.staleWhy':
    'The latest read of this target failed. The last health read was {state}, {source}. It is not shown as current.',
  'target.health.noSample': 'No health sample',
  'target.health.noSampleWhy': 'The target has not been sampled yet, so its health is not known.',
  // The count on the Findings tab.
  'target.nav.findingsOpen': '{count} open findings',
  'target.lifecycle.registered': 'Registered',
  'target.lifecycle.suspended': 'Suspended',
  'target.lifecycle.decommissioned': 'Decommissioned',
  'target.schema.kind': 'Object kind: {kind}',
  'target.placeholder.reason': 'This page of the Web App is not built yet.',
  'target.state.observation': 'Source: {source}. Observed',
  'target.state.observationNoSource': 'Source: not reported. Observed',
  'target.state.readHealth': 'Read health again',
  'target.state.decommissioned.title': 'This target is decommissioned',
  'target.state.decommissioned.body':
    'ExponetDB no longer manages it, and its path is never reused. Its history stays in the audit log.',
  'target.state.decommissioned.action': 'Go to databases',
  'target.state.suspended.title': 'This target is suspended',
  'target.state.suspended.body':
    'Writes are blocked until a person resumes it. The reason is in the audit log.',
  'target.state.suspended.action': 'Open the audit log',
  'target.state.wave9.reason': 'Its data comes from a part of ExponetDB that arrives with Wave 9.',
  'target.state.od21.reason':
    'It waits for the owner decision on the notification channel (OD-21).',
  'target.state.permission.what': 'This page',
  'target.state.noNode.title': 'Not supported on this target',
  'target.state.noNode.body':
    '{feature} needs a node agent on the cluster. The cluster of this target is managed outside ExponetDB and has none.',
  'target.state.unreachable.title': 'The target is unreachable',
  'target.state.unreachable.body':
    'ExponetDB could not reach this database on any registered path in its latest sample. This page reads samples and does not probe.',
  'target.state.unreachable.nodeAlive':
    'The node agent on its host is alive, so the problem is likely the database, its credentials or the network path to it.',
  'target.state.unreachable.nodeDown':
    'The node agent is not online either. ExponetDB cannot tell whether the network or the host failed.',
  'target.state.unreachable.noNode':
    'The cluster has no node agent, so ExponetDB cannot see its host.',
  'target.state.cannotTell.title': 'Cannot tell whether the target is reachable',
  'target.state.cannotTell.failed':
    'Could not read the health of this target: {reason} This does not mean it is unreachable.',
  'target.state.cannotTell.missing':
    'This page has no reading of the health of the target. This does not mean it is unreachable.',
  'target.state.cannotTell.unknown':
    'ExponetDB has no usable observation of this target. The database may be fine.',
  'target.state.nodeCannotTell.title': 'Cannot tell whether the node is online',
  'target.state.nodeCannotTell.failed':
    'Could not read the health of this target: {reason} This does not mean the node is offline.',
  'target.state.nodeCannotTell.missing':
    'This page has no reading of the node state. This does not mean the node is offline.',
  'target.state.nodeCannotTell.unknown':
    'ExponetDB has no usable observation of the node agent. The node may be fine.',
  'target.state.nodeOffline.title': 'The node is not online',
  'target.state.nodeOffline.body':
    'The node agent of this target reports {state}, so host actions are unavailable.',
  'target.unknown.none': 'No reason was reported.',
  'target.unknown.other': 'The reason code is {code}.',
  'target.unknown.control_plane_degraded': "ExponetDB's own sampler is not running.",
  'target.unknown.never_sampled': 'The target has not been sampled yet.',
  'target.unknown.sampler_lagging': 'The latest sample is too old.',
  'target.unknown.no_endpoint': 'The target has no registered endpoint.',
  'target.unknown.no_placement': 'The target has no placement.',
  'target.unknown.observer_credential_missing': 'The observer credential is not set.',
  'target.unknown.no_active_endpoint': 'The target has no active endpoint.',
} as const satisfies Readonly<Record<string, string>>
