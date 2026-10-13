import {
  Database,
  DatabaseBackup,
  GitCompareArrows,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Server,
  Settings,
  Users,
} from '@exponetdb/icons'
import type { CommandShortcutId } from '@exponetdb/ui-patterns'
import { SCHEMA_KINDS, type TARGET_SECTIONS } from '../lib/navigation/links.ts'

/**
 * The information architecture as data (information-architecture.md §2):
 * the sections of the icon rail, the pages of each section (its section
 * menu), the target sections and what each needs. The shell, the command
 * menu and the shortcut sheet read these lists; a page whose requirement
 * does not hold renders a named state instead of a broken page. `wave`
 * marks pages whose data arrives later (order D7): they exist, they are
 * navigable, and they say "not available yet".
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

export type SectionId =
  | 'overview'
  | 'targets'
  | 'changes'
  | 'infrastructure'
  | 'backups'
  | 'access'
  | 'audit'
  | 'settings'

/** A section of the icon rail. */
export interface NavSection {
  readonly id: SectionId
  readonly label: string
  /** Where the rail item goes: the section's first page. */
  readonly path: string
  /** The paths that belong to the section (each page and the pages below it). */
  readonly prefixes: readonly string[]
  readonly icon: LucideIcon
  /** The `G` sequence of the registry (`packages/ui-patterns/src/shortcuts`). */
  readonly shortcut: CommandShortcutId
  /** Sections of the same block sit together; a separator divides the blocks. */
  readonly block: 1 | 2 | 3 | 4
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    path: '/',
    prefixes: [],
    icon: LayoutDashboard,
    shortcut: 'nav.overview',
    block: 1,
  },
  {
    id: 'targets',
    label: 'Databases',
    path: '/targets',
    prefixes: ['/targets', '/t'],
    icon: Database,
    shortcut: 'nav.targets',
    block: 1,
  },
  {
    id: 'changes',
    label: 'Changes',
    path: '/changes',
    prefixes: ['/changes', '/approvals'],
    icon: GitCompareArrows,
    shortcut: 'nav.changes',
    block: 1,
  },
  {
    id: 'infrastructure',
    label: 'Infrastructure',
    path: '/infrastructure/servers',
    prefixes: ['/infrastructure'],
    icon: Server,
    shortcut: 'nav.infrastructure',
    block: 2,
  },
  {
    id: 'backups',
    label: 'Backups',
    path: '/backups',
    prefixes: ['/backups'],
    icon: DatabaseBackup,
    shortcut: 'nav.backups',
    block: 2,
  },
  {
    id: 'access',
    label: 'Access',
    path: '/access/people',
    prefixes: ['/access', '/connect'],
    icon: Users,
    shortcut: 'nav.access',
    block: 3,
  },
  {
    id: 'audit',
    label: 'Audit',
    path: '/audit',
    prefixes: ['/audit'],
    icon: ScrollText,
    shortcut: 'nav.audit',
    block: 3,
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/settings/products',
    prefixes: ['/settings'],
    icon: Settings,
    shortcut: 'nav.settings',
    block: 4,
  },
]

/** A page of the global level. */
export interface NavItem {
  readonly id: string
  /** Message-free label; the English text the shell shows. */
  readonly label: string
  readonly path: string
  readonly section: SectionId
  /** A shortcut of the registry that goes to this page, when the page has its own. */
  readonly shortcut?: CommandShortcutId
  readonly requires: readonly Requirement[]
  readonly wave?: '9'
}

export const GLOBAL_NAV: readonly NavItem[] = [
  { id: 'overview', label: 'Overview', path: '/', section: 'overview', requires: [] },
  { id: 'targets', label: 'Databases', path: '/targets', section: 'targets', requires: [] },
  { id: 'changes', label: 'All changes', path: '/changes', section: 'changes', requires: [] },
  {
    id: 'plans',
    label: 'Plans',
    path: '/changes/plans',
    section: 'changes',
    shortcut: 'nav.plans',
    requires: [],
  },
  {
    id: 'operations',
    label: 'Operations',
    path: '/changes/operations',
    section: 'changes',
    shortcut: 'nav.operations',
    requires: [],
  },
  {
    id: 'promotion',
    label: 'Promotion',
    path: '/changes/promotion',
    section: 'changes',
    requires: [],
  },
  { id: 'approvals', label: 'Approvals', path: '/approvals', section: 'changes', requires: [] },
  {
    id: 'servers',
    label: 'Servers',
    path: '/infrastructure/servers',
    section: 'infrastructure',
    requires: [],
  },
  {
    id: 'clusters',
    label: 'Clusters',
    path: '/infrastructure/clusters',
    section: 'infrastructure',
    requires: [],
  },
  {
    id: 'nodes',
    label: 'Nodes',
    path: '/infrastructure/nodes',
    section: 'infrastructure',
    requires: [],
  },
  {
    id: 'certificates',
    label: 'Certificates',
    path: '/infrastructure/certificates',
    section: 'infrastructure',
    requires: [],
  },
  {
    id: 'backups',
    label: 'Backups',
    path: '/backups',
    section: 'backups',
    requires: ['wave9'],
    wave: '9',
  },
  {
    id: 'people',
    label: 'People',
    path: '/access/people',
    section: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'roles',
    label: 'Roles',
    path: '/access/roles',
    section: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'service-accounts',
    label: 'Service accounts',
    path: '/access/service-accounts',
    section: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'oauth-clients',
    label: 'OAuth clients',
    path: '/access/oauth-clients',
    section: 'access',
    requires: ['permission:access.read'],
  },
  {
    id: 'connected-apps',
    label: 'Connected apps',
    path: '/access/connected-apps',
    section: 'access',
    requires: [],
  },
  // How to connect an MCP client to this installation (order §8); API keys live on the
  // service accounts page, so they have no page of their own.
  { id: 'connect', label: 'Connect a client', path: '/connect', section: 'access', requires: [] },
  {
    id: 'audit',
    label: 'Audit',
    path: '/audit',
    section: 'audit',
    requires: ['permission:audit.read'],
  },
  {
    id: 'products',
    label: 'Products',
    path: '/settings/products',
    section: 'settings',
    requires: [],
  },
  {
    id: 'environments',
    label: 'Environments',
    path: '/settings/environments',
    section: 'settings',
    requires: [],
  },
  {
    id: 'policies',
    label: 'Policies',
    path: '/settings/policies',
    section: 'settings',
    requires: [],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    path: '/settings/notifications',
    section: 'settings',
    requires: ['od21'],
  },
  {
    id: 'installation',
    label: 'Installation',
    path: '/settings/installation',
    section: 'settings',
    requires: [],
  },
  {
    id: 'break-glass',
    label: 'Break-glass',
    path: '/settings/break-glass',
    section: 'settings',
    requires: ['permission:policy.manage'],
  },
]

/** Whether `pathname` is the page at `path` or a page below it (never a sibling sharing a prefix). */
export function isCurrent(path: string, pathname: string): boolean {
  if (path === '/') return pathname === '/'
  return pathname === path || pathname.startsWith(`${path}/`)
}

/** The rail section a path belongs to; the overview only at `/`. */
export function sectionOf(pathname: string): NavSection | undefined {
  if (pathname === '/') return NAV_SECTIONS[0]
  return NAV_SECTIONS.find((section) =>
    section.prefixes.some((prefix) => isCurrent(prefix, pathname)),
  )
}

/** The pages of a section, its section menu; a section with one page has none. */
export function sectionMenu(section: SectionId): readonly NavItem[] {
  const pages = GLOBAL_NAV.filter((item) => item.section === section)
  return pages.length > 1 ? pages : []
}

export type TargetSection = (typeof TARGET_SECTIONS)[number] | 'overview'

export interface TargetNavItem {
  readonly id: TargetSection
  readonly label: string
  /** Appended to `/t/<product>/<project>/<environment>`. */
  readonly suffix: string
  readonly requires: readonly Requirement[]
  readonly wave?: '9'
}

/** The target sections in the order of the owner brief (information-architecture.md §2.2). */
export const TARGET_NAV: readonly TargetNavItem[] = [
  { id: 'overview', label: 'Overview', suffix: '', requires: [] },
  {
    id: 'schema',
    label: 'Schema',
    suffix: '/schema',
    requires: ['target.reachable'],
  },
  { id: 'migrations', label: 'Migrations', suffix: '/migrations', requires: [] },
  { id: 'sql', label: 'SQL', suffix: '/sql', requires: ['target.reachable'] },
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
    requires: ['target.reachable'],
  },
  { id: 'locks', label: 'Locks', suffix: '/locks', requires: ['target.reachable'] },
  { id: 'backups', label: 'Backups', suffix: '/backups', requires: ['wave9'], wave: '9' },
  { id: 'configuration', label: 'Configuration', suffix: '/configuration', requires: [] },
  { id: 'findings', label: 'Findings', suffix: '/findings', requires: [] },
  { id: 'drift', label: 'Drift', suffix: '/drift', requires: [] },
  { id: 'advisors', label: 'Advisors', suffix: '/advisors', requires: ['wave9'], wave: '9' },
  { id: 'activity', label: 'Activity', suffix: '/activity', requires: [] },
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
