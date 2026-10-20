/**
 * Registry of the data components of the Web App and the tests that prove their read states
 * (C-28, Wave 8 order §10 Phase 15 and §11). `truthful-states.test.ts` fails when
 *
 * - a `.tsx` file under `src/features/**` renders a `Readable<T>` (it uses `ReadableView`,
 *   `toReadable`, `Readable<…>` or `<ReadSection`) and has no entry here, so a new screen
 *   without an entry fails;
 * - an entry names a source or a test file that does not exist;
 * - the named test files lack a test for one of the four states, unless the entry exempts that
 *   state with a reason.
 *
 * Adding a screen is one line:
 * `'src/features/<area>/<file>.tsx': { tests: ['<dir>/<file>.test.tsx'] },`
 * (test paths are relative to `apps/web/test`).
 *
 * Marker convention: a state is covered when the name of one `it(...)` or `test(...)` in the
 * named files contains a word of the state, case insensitive (see `STATE_MARKERS`):
 *
 *   failed   `fail` (failed, failure)   a failed read shows the failure text, not the empty text
 *   stale    `stale`, `old`, `earlier`  an old read shows its age and a refresh
 *   partial  `partial`, `truncated`, `incomplete`, `cut`, `missing`   it names what is missing
 *   empty    `empty`, `none`, `no <thing>`   empty is said only after a successful read
 *
 * The loading and ready states are covered by every page test and are not matched by name.
 * The marker proves a test exists and is named for the state; the assertions are in the test.
 *
 * An exemption is explicit: `exempt: { stale: 'reason' }`. The reason says why the API of the
 * component cannot yield that state; silence is never an exemption.
 */

export const STATES = ['failed', 'stale', 'partial', 'empty'] as const
export type State = (typeof STATES)[number]

export const STATE_MARKERS: Record<State, RegExp> = {
  failed: /fail/i,
  stale: /\b(stale|old|earlier)\b/i,
  partial: /\b(partial|truncated|incomplete|cut|missing)\b/i,
  empty: /\b(empty|none|no\s+\w+)\b/i,
}

export interface Coverage {
  /** Test files, relative to `apps/web/test`. */
  readonly tests: readonly string[]
  /** States this component cannot show, each with the reason. */
  readonly exempt?: Partial<Record<State, string>>
}

const ADMIN = 'truthful-states/admin-read-states.test.tsx'
const SCHEMA = ['schema/schema.test.tsx']
const OVERVIEW = ['target-overview/overview.test.tsx']
const MIGRATIONS = ['target-pages/migrations.test.tsx']
const SERVERS = ['infrastructure/servers.test.tsx']
const CLUSTERS = ['infrastructure/clusters.test.tsx']
const NODES = ['infrastructure/nodes.test.tsx']
const ACCOUNT = ['account/account-page.test.tsx', ADMIN]
const TARGET_FRAME = ['target/content-wrapper.test.tsx', 'target/layout.test.tsx']
const SETTINGS_STATES = 'truthful-states/settings-read-states.test.tsx'
const TARGET_PAGES = 'truthful-states/target-read-states.test.tsx'

/** A read of one target by path: the answer is one object, with no cursor or truncation flag. */
const ONE_OBJECT: Partial<Record<State, string>> = {
  partial:
    'This component reads one target by path: the response is one object, with no cursor or truncation flag, so a read cannot be partial.',
}

export const COVERAGE: Record<string, Coverage> = {
  'src/features/access/list-view.tsx': {
    tests: ['access/oauth-clients.test.tsx', 'access/service-accounts.test.tsx', ADMIN],
  },
  'src/features/access/api-keys-overview.tsx': { tests: ['access/api-keys-overview.test.tsx'] },
  'src/features/access/choice-select.tsx': { tests: ['access/choice-select.test.tsx'] },
  'src/features/access/oauth-clients-page.tsx': {
    tests: ['access/oauth-clients.test.tsx', 'access/oauth-client-filters.test.tsx', ADMIN],
  },
  'src/features/access/service-accounts-page.tsx': {
    tests: ['access/service-accounts.test.tsx', 'access/service-lifecycle.test.tsx', ADMIN],
  },
  'src/features/access/connected-apps-page.tsx': { tests: ['admin/access-pages.test.tsx'] },
  'src/features/access/people-page.tsx': {
    tests: ['admin/access-pages.test.tsx', 'admin/people-filters.test.tsx'],
  },
  'src/features/access/roles-page.tsx': { tests: ['admin/access-pages.test.tsx'] },
  'src/features/account/factors-section.tsx': { tests: ACCOUNT },
  'src/features/account/grants-section.tsx': { tests: ACCOUNT },
  'src/features/account/pages.tsx': { tests: ACCOUNT },
  'src/features/account/passkeys-section.tsx': { tests: ACCOUNT },
  'src/features/account/security-page.tsx': { tests: ACCOUNT },
  'src/features/account/sessions-section.tsx': { tests: ACCOUNT },
  'src/features/activity/activity-page.tsx': {
    tests: ['target-pages/activity.test.tsx', TARGET_PAGES],
  },
  'src/features/approvals/approvals-page.tsx': {
    tests: ['approvals/approvals-page.test.tsx'],
    exempt: {
      partial:
        'GET /approvals answers { items } with no cursor or truncation flag (ApprovalQueueItem list), so the queue read cannot be partial.',
    },
  },
  'src/features/audit/audit-page.tsx': { tests: ['audit/audit-page.test.tsx', SETTINGS_STATES] },
  'src/features/audit/chain-panel.tsx': {
    tests: ['audit/audit-page.test.tsx', 'truthful-states/audit-chain-states.test.tsx'],
    exempt: {
      partial:
        'GET /audit-events/chain answers one verification object with no cursor or truncation flag, so the chain read cannot be partial.',
    },
  },
  'src/features/changes/operation-page.tsx': { tests: ['changes/operation-page.test.tsx'] },
  'src/features/changes/operations-page.tsx': { tests: ['changes/operations-page.test.tsx'] },
  'src/features/changes/promotion-page.tsx': { tests: ['changes/promotion-page.test.tsx'] },
  'src/features/compare/compare-page.tsx': { tests: ['target-pages/compare.test.tsx'] },
  'src/features/configuration/configuration-page.tsx': {
    tests: ['target-pages/configuration.test.tsx'],
  },
  'src/features/configuration/connect-section.tsx': {
    tests: ['target-pages/configuration-connect.test.tsx'],
  },
  'src/features/connections/attention-strip.tsx': { tests: ['connections/attention.test.tsx'] },
  'src/features/connections/endpoints-view.tsx': { tests: ['connections/connections.test.tsx'] },
  'src/features/connections/live-read.tsx': {
    tests: ['connections/connections.test.tsx', 'connections/locks.test.tsx'],
  },
  'src/features/connections/locks-view.tsx': {
    tests: ['connections/locks.test.tsx', 'connections/locks-join.test.tsx'],
  },
  'src/features/drift/drift-page.tsx': { tests: ['target-pages/drift.test.tsx', TARGET_PAGES] },
  'src/features/findings/findings-page.tsx': {
    tests: ['target-pages/findings.test.tsx', TARGET_PAGES],
  },
  'src/features/fleet/attention.tsx': { tests: ['fleet/attention.test.tsx'] },
  'src/features/fleet/fleet-page.tsx': { tests: ['fleet/fleet-page.test.tsx'] },
  'src/features/global-findings/findings-page.tsx': {
    tests: ['global-findings/findings-page.test.tsx'],
  },
  'src/features/infrastructure/certificates-page.tsx': {
    tests: ['infrastructure/certificates.test.tsx'],
  },
  'src/features/infrastructure/bootstrap-sql.tsx': {
    tests: ['infrastructure/registration.test.tsx'],
    exempt: {
      partial:
        'GET /clusters/{id}/bootstrap-sql answers one script with its roles and databases and no cursor or truncation flag, so the read cannot be partial.',
    },
  },
  'src/features/infrastructure/cluster-detail.tsx': { tests: CLUSTERS },
  'src/features/infrastructure/cluster-roles.tsx': { tests: CLUSTERS },
  'src/features/infrastructure/clusters-page.tsx': { tests: CLUSTERS },
  'src/features/infrastructure/enrollment.tsx': { tests: NODES },
  'src/features/infrastructure/node-detail.tsx': { tests: NODES },
  'src/features/infrastructure/nodes-page.tsx': { tests: NODES },
  'src/features/infrastructure/server-detail.tsx': { tests: SERVERS },
  'src/features/infrastructure/servers-page.tsx': { tests: SERVERS },
  'src/features/migrations/bundle-sheet.tsx': {
    tests: ['target-pages/migration-actions.test.tsx'],
  },
  'src/features/migrations/drift-summary.tsx': { tests: MIGRATIONS },
  'src/features/migrations/ledger-section.tsx': { tests: MIGRATIONS },
  'src/features/migrations/legacy-import.tsx': { tests: MIGRATIONS },
  'src/features/migrations/plans-section.tsx': { tests: MIGRATIONS },
  'src/features/migrations/timeline-section.tsx': { tests: MIGRATIONS },
  'src/features/plans/plan-list.tsx': { tests: ['plans/plan-list.test.tsx'] },
  'src/features/plans/plan-page.tsx': { tests: ['plans/plan-page.test.tsx'] },
  'src/features/plans/stored-files.tsx': {
    tests: ['plans/plan-actions.test.tsx'],
    exempt: {
      stale:
        'useStoredFiles yields loading, failed, partial or ready only: a stored bundle revision never changes (bundles are append-only), so its files are read once and an earlier read is never out of date.',
    },
  },
  'src/features/schema/browse-panel.tsx': { tests: ['schema/browse.test.tsx'] },
  'src/features/schema/object-detail.tsx': { tests: SCHEMA },
  'src/features/schema/object-list.tsx': { tests: SCHEMA },
  'src/features/schema/schema-page.tsx': { tests: SCHEMA },
  'src/features/schema/status-block.tsx': { tests: SCHEMA },
  'src/features/schema/tree-panel.tsx': { tests: SCHEMA },
  'src/features/schema/visualizer.tsx': { tests: SCHEMA },
  'src/features/settings/break-glass-page.tsx': {
    tests: ['settings/break-glass.test.tsx', SETTINGS_STATES],
  },
  'src/features/settings/environments-page.tsx': {
    tests: ['settings/settings-pages.test.tsx', SETTINGS_STATES],
  },
  'src/features/settings/installation-page.tsx': {
    tests: ['settings/settings-pages.test.tsx', SETTINGS_STATES],
  },
  'src/features/settings/policies-page.tsx': {
    tests: ['settings/settings-pages.test.tsx', SETTINGS_STATES],
  },
  'src/features/settings/products-page.tsx': {
    tests: ['settings/settings-pages.test.tsx', SETTINGS_STATES],
  },
  'src/features/settings/projects-page.tsx': { tests: ['settings/projects.test.tsx'] },
  'src/features/sql/side-panel.tsx': { tests: ['sql/sql-page.test.tsx'] },
  'src/features/target-ops/read-section.tsx': {
    tests: [
      'target-pages/activity.test.tsx',
      'target-pages/drift.test.tsx',
      'target-pages/findings.test.tsx',
      'target-pages/migrations.test.tsx',
    ],
  },
  'src/features/target-overview/activity-blocks.tsx': { tests: OVERVIEW },
  'src/features/target-overview/health-block.tsx': { tests: OVERVIEW },
  'src/features/target-overview/history-block.tsx': {
    tests: [...OVERVIEW, 'target-overview/history.test.tsx'],
  },
  'src/features/target-overview/host-row.tsx': {
    tests: ['target-overview/host.test.tsx'],
    exempt: {
      partial:
        'GET /nodes/{nodeId} answers one node object with no cursor or truncation flag, so the host read cannot be partial; a node that sent no host values is the "not reported" state, tested as empty.',
    },
  },
  'src/features/target-overview/migrations-block.tsx': { tests: OVERVIEW },
  'src/features/target/content-wrapper.tsx': { tests: TARGET_FRAME, exempt: ONE_OBJECT },
  'src/features/target/context-bar.tsx': { tests: ['target/context-bar.test.tsx'] },
  'src/features/target/database-choices.tsx': {
    tests: ['target/database-switcher.test.tsx', 'shell/switch-database-command.test.tsx'],
  },
  'src/features/target/health-chip.tsx': { tests: ['target/health-chip.test.tsx'] },
  'src/features/target/scope.tsx': { tests: TARGET_FRAME, exempt: ONE_OBJECT },
  'src/features/target/target-nav.tsx': { tests: ['target/target-nav.test.tsx'] },
  'src/features/targets/register-page.tsx': { tests: ['targets/register-page.test.tsx'] },
  'src/features/targets/targets-page.tsx': {
    tests: ['targets/targets-page.test.tsx', 'targets/targets-filters.test.tsx'],
  },
}
