import { SCHEMA_KINDS, type TARGET_SECTIONS } from '../lib/navigation/links.ts'

/**
 * The information architecture as data (information-architecture.md §2):
 * the global sections, the target sections and what each needs. The shell,
 * the command menu and the shortcut sheet read this one list; a page whose
 * requirement does not hold renders a named state instead of a broken page.
 * `wave` marks pages whose data arrives later (order D7): they exist, they
 * are navigable, and they say "not available yet".
 */
export type Requirement =
  | 'target.reachable'
  | 'node.online'
  | 'wave9'
  | 'od21'
  | 'permission:access.read'
  | 'permission:audit.read'
  | 'permission:registry.manage'
  | 'permission:plans.approve'
  | 'permission:policy.manage'

export interface NavItem {
  readonly id: string
  /** Message-free label: the shell translates by id (`nav.<id>`); this is the English fallback. */
  readonly label: string
  readonly path: string
  readonly group: 'fleet' | 'changes' | 'infrastructure' | 'access' | 'records' | 'settings'
  /** `G` then this key. */
  readonly shortcut?: string
  readonly requires: readonly Requirement[]
  readonly wave?: '9'
}

export const GLOBAL_NAV: readonly NavItem[] = [
  { id: 'overview', label: 'Overview', path: '/', group: 'fleet', shortcut: 'o', requires: [] },
  {
    id: 'targets',
    label: 'Databases',
    path: '/targets',
    group: 'fleet',
    shortcut: 'd',
    requires: [],
  },
  {
    id: 'changes',
    label: 'Changes',
    path: '/changes',
    group: 'changes',
    shortcut: 'c',
    requires: [],
  },
  {
    id: 'approvals',
    label: 'Approvals',
    path: '/approvals',
    group: 'changes',
    shortcut: 'a',
    requires: [],
  },
  {
    id: 'servers',
    label: 'Servers',
    path: '/infrastructure/servers',
    group: 'infrastructure',
    requires: [],
  },
  {
    id: 'clusters',
    label: 'Clusters',
    path: '/infrastructure/clusters',
    group: 'infrastructure',
    shortcut: 'k',
    requires: [],
  },
  {
    id: 'nodes',
    label: 'Nodes',
    path: '/infrastructure/nodes',
    group: 'infrastructure',
    shortcut: 'n',
    requires: [],
  },
  {
    id: 'certificates',
    label: 'Certificates',
    path: '/infrastructure/certificates',
    group: 'infrastructure',
    requires: [],
  },
  {
    id: 'backups',
    label: 'Backups',
    path: '/backups',
    group: 'infrastructure',
    requires: ['wave9'],
    wave: '9',
  },
  {
    id: 'people',
    label: 'People',
    path: '/access/people',
    group: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'roles',
    label: 'Roles',
    path: '/access/roles',
    group: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'service-accounts',
    label: 'Service accounts',
    path: '/access/service-accounts',
    group: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'api-keys',
    label: 'API keys',
    path: '/access/api-keys',
    group: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'oauth-clients',
    label: 'OAuth clients',
    path: '/access/oauth-clients',
    group: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'connected-apps',
    label: 'Connected apps',
    path: '/access/connected-apps',
    group: 'access',
    requires: [],
  },
  {
    id: 'audit',
    label: 'Audit',
    path: '/audit',
    group: 'records',
    shortcut: 'u',
    requires: ['permission:audit.read'],
  },
  {
    id: 'products',
    label: 'Products',
    path: '/settings/products',
    group: 'settings',
    requires: [],
  },
  {
    id: 'environments',
    label: 'Environments',
    path: '/settings/environments',
    group: 'settings',
    requires: [],
  },
  {
    id: 'policies',
    label: 'Policies',
    path: '/settings/policies',
    group: 'settings',
    requires: [],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    path: '/settings/notifications',
    group: 'settings',
    requires: ['od21'],
  },
  {
    id: 'installation',
    label: 'Installation',
    path: '/settings/installation',
    group: 'settings',
    requires: [],
  },
]

export type TargetSection = (typeof TARGET_SECTIONS)[number] | 'overview'

export interface TargetNavItem {
  readonly id: TargetSection
  readonly label: string
  /** Appended to `/t/<product>/<project>/<environment>`. */
  readonly suffix: string
  readonly shortcut?: string
  readonly requires: readonly Requirement[]
  readonly wave?: '9'
}

/** The target sections in the order of the owner brief (information-architecture.md §2.2). */
export const TARGET_NAV: readonly TargetNavItem[] = [
  { id: 'overview', label: 'Overview', suffix: '', shortcut: 'o', requires: [] },
  {
    id: 'schema',
    label: 'Schema',
    suffix: '/schema',
    shortcut: 's',
    requires: ['target.reachable'],
  },
  { id: 'migrations', label: 'Migrations', suffix: '/migrations', shortcut: 'm', requires: [] },
  { id: 'sql', label: 'SQL', suffix: '/sql', shortcut: 'q', requires: ['target.reachable'] },
  {
    id: 'performance',
    label: 'Performance',
    suffix: '/performance',
    requires: ['wave9'],
    wave: '9',
  },
  {
    id: 'connections',
    label: 'Connections',
    suffix: '/connections',
    shortcut: 'x',
    requires: ['target.reachable'],
  },
  { id: 'locks', label: 'Locks', suffix: '/locks', shortcut: 'l', requires: ['target.reachable'] },
  { id: 'backups', label: 'Backups', suffix: '/backups', requires: ['wave9'], wave: '9' },
  { id: 'configuration', label: 'Configuration', suffix: '/configuration', requires: [] },
  { id: 'findings', label: 'Findings', suffix: '/findings', requires: [] },
  { id: 'drift', label: 'Drift', suffix: '/drift', requires: [] },
  { id: 'advisors', label: 'Advisors', suffix: '/advisors', requires: ['wave9'], wave: '9' },
  { id: 'activity', label: 'Activity', suffix: '/activity', shortcut: 'y', requires: [] },
]

export interface TargetPath {
  readonly product: string
  readonly project: string
  readonly environment: string
}

/** `/t/<product>/<project>/<environment><suffix>`, each segment percent-encoded. */
export function targetHref(target: TargetPath, suffix = ''): string {
  return `/t/${encodeURIComponent(target.product)}/${encodeURIComponent(target.project)}/${encodeURIComponent(target.environment)}${suffix}`
}

/**
 * The same page on another environment of the same project ("switching
 * environment keeps the page", IA §3): only the section and a schema kind
 * survive the switch; anything deeper (an object name) is dropped, because
 * it may not exist there.
 */
export function switchEnvironment(pathname: string, environment: string): string | undefined {
  const m = /^\/t\/([^/]+)\/([^/]+)\/[^/]+(\/[^/]+)?(\/[^/]+)?/.exec(pathname)
  if (m === null) return undefined
  const [, product = '', project = '', section, sub] = m
  const sectionName = section?.slice(1)
  const keepSection = TARGET_NAV.some((s) => s.suffix !== '' && s.suffix === section)
  const keepSub =
    keepSection &&
    sectionName === 'schema' &&
    sub !== undefined &&
    (SCHEMA_KINDS as readonly string[]).includes(sub.slice(1))
  return `/t/${product}/${project}/${encodeURIComponent(environment)}${keepSection ? section : ''}${keepSub ? sub : ''}`
}
