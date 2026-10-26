import { Bot, Code, Database, Globe, type LucideIcon, Plug, Terminal } from '@exponetdb/icons'
import {
  Button,
  cn,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@exponetdb/ui'
import {
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { useRouter, useRouterState } from '@tanstack/react-router'
import { type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { stringifySearch } from '../../lib/navigation/search.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import type { ConnectModel } from '../configuration/connect-model.ts'
import {
  ConnectDetails,
  ConnectNotPermitted,
  Snippet,
  useConnectQuery,
} from '../configuration/connect-section.tsx'
import { environmentsQuery } from '../target/keys.ts'
import { isSlug } from '../target/params.ts'
import { nounPhrase } from '../target/phrases.ts'
import { type Target, useTarget } from '../target/queries.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import { mcpServerUrl, SCOPE_SETS } from './clients.ts'
import {
  APP_FRAMEWORKS,
  type AppFramework,
  apiSnippets,
  appSnippets,
  CONNECT_ENVIRONMENT_PARAM,
  CONNECT_MODES,
  CONNECT_PARAM,
  type ConnectMode,
  cliCommands,
  isConnectMode,
} from './target-connect-model.ts'

const MODE_ICON: Readonly<Record<ConnectMode, LucideIcon>> = {
  direct: Database,
  app: Code,
  cli: Terminal,
  mcp: Bot,
  api: Globe,
}

const FRAMEWORK_LABEL: Readonly<Record<AppFramework, MessageKey>> = {
  env: 'connectSheet.app.framework.env',
  node: 'connectSheet.app.framework.node',
  python: 'connectSheet.app.framework.python',
  go: 'connectSheet.app.framework.go',
}

/** The search of the address as the router parsed it: plain strings (`parseSearch`). */
function useLocation(): { readonly pathname: string; readonly search: Record<string, unknown> } {
  const location = useRouterState({ select: (state) => state.location })
  return { pathname: location.pathname, search: location.search as Record<string, unknown> }
}

/**
 * The Connect button of a target (in the header of its pages) or of a project (on its home,
 * with the environment chosen in the sheet), and the wide sheet it opens (ADR-0034 §4).
 *
 * The sheet's state is the address: `?connect=<mode>` (an allowlist value) and, for a project,
 * `?environment=<slug>`; a reload or a link opens it again, Back closes it, and the page's own
 * search parameters stay as they are. It is a modal dialog on the right (full screen on a
 * phone): focus is trapped inside, Escape closes it and focus returns to the button.
 */
export function TargetConnectButton({
  product,
  project,
  environment,
}: {
  readonly product: string
  readonly project: string
  /** The target's environment; left out on a project's home, where the sheet asks for it. */
  readonly environment?: string
}): ReactNode {
  const navigate = useNavigate()
  const router = useRouter()
  const location = useLocation()
  const button = useRef<HTMLButtonElement>(null)
  // Whether this page pushed the history entry that opened the sheet: then closing goes back.
  const pushed = useRef(false)
  const raw = location.search[CONNECT_PARAM]
  const mode = isConnectMode(raw) ? raw : undefined
  const chosen = location.search[CONNECT_ENVIRONMENT_PARAM]
  const sheetEnvironment = environment ?? (isSlug(chosen) ? chosen : undefined)
  const hrefWith = (next: Record<string, unknown>) =>
    `${location.pathname}${stringifySearch({ ...location.search, ...next })}`
  const open = () => {
    pushed.current = true
    navigate(hrefWith({ [CONNECT_PARAM]: 'direct' }))
  }
  const close = () => {
    if (pushed.current) {
      pushed.current = false
      router.history.back()
      return
    }
    navigate(hrefWith({ [CONNECT_PARAM]: undefined, [CONNECT_ENVIRONMENT_PARAM]: undefined }), {
      replace: true,
    })
  }
  return (
    <>
      <Button
        ref={button}
        type="button"
        variant="default"
        size="tiny"
        className="rounded-full max-md:px-1.5"
        aria-haspopup="dialog"
        icon={<Plug aria-hidden="true" className="rotate-90" strokeWidth={1.5} />}
        onClick={open}
      >
        <span className="max-md:sr-only">{t('connectSheet.button')}</span>
      </Button>
      <Sheet open={mode !== undefined} onOpenChange={(next) => (next ? undefined : close())}>
        {mode === undefined ? null : (
          <SheetContent
            side="right"
            size="w800"
            className="flex h-full max-h-dvh flex-col gap-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              button.current?.focus()
            }}
          >
            <SheetBody
              product={product}
              project={project}
              environment={sheetEnvironment}
              fixedEnvironment={environment !== undefined}
              mode={mode}
              onMode={(next) => navigate(hrefWith({ [CONNECT_PARAM]: next }), { replace: true })}
              onEnvironment={(next) =>
                navigate(hrefWith({ [CONNECT_ENVIRONMENT_PARAM]: next }), { replace: true })
              }
            />
          </SheetContent>
        )}
      </Sheet>
    </>
  )
}

function SheetBody(props: {
  readonly product: string
  readonly project: string
  readonly environment: string | undefined
  readonly fixedEnvironment: boolean
  readonly mode: ConnectMode
  readonly onMode: (mode: ConnectMode) => void
  readonly onEnvironment: (environment: string) => void
}): ReactNode {
  const { product, project } = props
  const { client } = useApi()
  // On a project's home the sheet lists the project's environments (the read the page shares);
  // without a choice in the address it is for the first non-production one.
  const list = useQuery({
    ...environmentsQuery(client, product, project),
    enabled: !props.fixedEnvironment && isSlug(product) && isSlug(project),
  })
  const choices = list.data === undefined ? [] : environmentChoices(list.data.items)
  const environment = props.fixedEnvironment
    ? props.environment
    : (choices.find((choice) => choice.slug === props.environment)?.slug ?? choices[0]?.slug)
  const path =
    environment === undefined ? `${product}/${project}` : `${product}/${project}/${environment}`
  return (
    <>
      <SheetHeader className="pr-12 text-left">
        <SheetTitle className="flex flex-wrap items-center gap-2">
          <span>{t('connectSheet.title', { path })}</span>
          {environment === undefined ? null : <SheetTier path={path} />}
        </SheetTitle>
        <SheetDescription>{t('connectSheet.description')}</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-6 px-5 py-5">
          {props.fixedEnvironment ? null : (
            <ReadableView
              readable={toReadable(list)}
              what={t('connectSheet.environment.what')}
              onRetry={() => void list.refetch()}
              onRefresh={() => void list.refetch()}
              busy={list.isFetching}
              headingLevel={3}
              empty={{
                isEmpty: () => choices.length === 0,
                content: (
                  <p className="m-0 text-sm text-foreground-light">
                    {t('connectSheet.environment.none')}
                  </p>
                ),
              }}
              ready={() => (
                <EnvironmentPicker
                  choices={choices}
                  environment={environment}
                  onEnvironment={props.onEnvironment}
                />
              )}
            />
          )}
          <ModePicker mode={props.mode} onMode={props.onMode} />
          {environment === undefined ? null : <ModeBody mode={props.mode} path={path} />}
        </div>
      </div>
    </>
  )
}

interface EnvironmentChoice {
  readonly slug: string
  readonly tier: 'prod' | 'nonprod'
}

/** The live environments of a project's target list, non-production first, then by slug. */
export function environmentChoices(
  items: readonly {
    readonly path: string
    readonly tier: 'prod' | 'nonprod'
    readonly state: string
  }[],
): readonly EnvironmentChoice[] {
  return items
    .filter((item) => item.state !== 'decommissioned')
    .map((item) => ({ slug: item.path.split('/')[2] ?? '', tier: item.tier }))
    .filter((item) => isSlug(item.slug))
    .sort((a, b) =>
      a.tier === b.tier ? a.slug.localeCompare(b.slug) : a.tier === 'nonprod' ? -1 : 1,
    )
}

function SheetTier({ path }: { readonly path: string }): ReactNode {
  const read = useTarget(path)
  const tier =
    read.readable.state === 'ready' || read.readable.state === 'stale'
      ? read.readable.value.tier
      : undefined
  return tier === undefined ? null : <TierChip tier={tier} />
}

/** On a project's home: which environment the sheet is for. */
function EnvironmentPicker(props: {
  readonly choices: readonly EnvironmentChoice[]
  readonly environment: string | undefined
  readonly onEnvironment: (environment: string) => void
}): ReactNode {
  const id = useId()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm text-foreground-light">
        {t('connectSheet.environment')}
      </label>
      <select
        id={id}
        value={props.environment}
        onChange={(event) => props.onEnvironment(event.target.value)}
        className="h-8 cursor-pointer rounded-md border border-control bg-field px-2 text-sm focus-ring"
      >
        {props.choices.map((choice) => (
          <option key={choice.slug} value={choice.slug}>
            {choice.tier === 'nonprod'
              ? choice.slug
              : t('connectSheet.environment.production', { slug: choice.slug })}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * The ways to connect as one choice: a group of radio buttons drawn as cards, so the arrow keys
 * move between them and a screen reader hears one choice with its options.
 */
function ModePicker({
  mode,
  onMode,
}: {
  readonly mode: ConnectMode
  readonly onMode: (mode: ConnectMode) => void
}): ReactNode {
  const name = useId()
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 text-sm font-medium">{t('connectSheet.modes')}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {CONNECT_MODES.map((candidate) => {
          const Icon = MODE_ICON[candidate]
          const checked = candidate === mode
          return (
            <label
              key={candidate}
              data-mode={candidate}
              className={cn(
                'relative flex cursor-pointer items-start gap-3 rounded-lg border bg-surface-100 p-3 transition-colors',
                'hover:border-strong hover:bg-surface-200/60 motion-reduce:transition-none',
                'has-[:focus-visible]:ring-[length:var(--focus-ring-width)] has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background',
                checked && 'border-primary bg-primary-200/30',
              )}
            >
              <input
                type="radio"
                name={name}
                value={candidate}
                checked={checked}
                onChange={() => onMode(candidate)}
                className="sr-only"
              />
              <Icon
                aria-hidden="true"
                strokeWidth={1.5}
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  checked ? 'text-primary' : 'text-foreground-light',
                )}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{t(`connectSheet.mode.${candidate}`)}</span>
                <span className="text-xs text-foreground-light">
                  {t(`connectSheet.mode.${candidate}.line`)}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function ModeBody({
  mode,
  path,
}: {
  readonly mode: ConnectMode
  readonly path: string
}): ReactNode {
  const read = useTarget(path)
  const origin = window.location.origin
  switch (mode) {
    case 'direct':
    case 'app':
      return (
        <ReadableView
          readable={read.readable}
          what={t('connectSheet.target.what')}
          onRetry={read.refetch}
          onRefresh={read.refetch}
          busy={read.fetching}
          headingLevel={3}
          ready={(target) =>
            mode === 'direct' ? (
              <ConnectDetails target={target} />
            ) : (
              <AppTemplates target={target} />
            )
          }
        />
      )
    case 'cli':
      return <CliSteps origin={origin} path={path} />
    case 'mcp':
      return <McpPanel origin={origin} />
    case 'api':
      return <ApiPanel origin={origin} path={path} />
  }
}

function AppTemplates({ target }: { readonly target: Target }): ReactNode {
  const me = useMe()
  const clusterId = target.placement?.clusterId
  if (!holds(me, 'registry.manage')) return <ConnectNotPermitted />
  if (clusterId === undefined) {
    return (
      <p className="m-0 text-sm text-foreground-light">{t('configuration.connect.noPlacement')}</p>
    )
  }
  return <AppTemplatesRead target={target} clusterId={clusterId} />
}

function AppTemplatesRead({
  target,
  clusterId,
}: {
  readonly target: Target
  readonly clusterId: string
}): ReactNode {
  const query = useConnectQuery(target, clusterId)
  return (
    <ReadSection
      query={query}
      what={nounPhrase('configuration.connect.what')}
      permission="registry.manage"
      missing={(value) => (value.model.missing.length === 0 ? undefined : value.model.missing)}
      empty={{
        isEmpty: (value) => value.model.endpoints.length === 0,
        content: (
          <p className="m-0 text-sm text-foreground-light">{t('configuration.connect.empty')}</p>
        ),
      }}
      ready={(value) => <Templates model={value.model} />}
    />
  )
}

function Templates({ model }: { readonly model: ConnectModel }): ReactNode {
  const id = useId()
  const [endpointId, setEndpointId] = useState(model.endpoints[0]?.id ?? '')
  const endpoint =
    model.endpoints.find((candidate) => candidate.id === endpointId) ?? model.endpoints[0]
  if (endpoint === undefined) return null
  if (model.database === undefined) {
    return <p className="m-0 text-sm text-foreground-light">{t('connectSheet.app.noDatabase')}</p>
  }
  const built = appSnippets(endpoint, model.database)
  return (
    <div className="flex flex-col gap-4">
      {model.endpoints.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="text-sm text-foreground-light">
            {t('connectSheet.app.endpoint')}
          </label>
          <select
            id={id}
            value={endpoint.id}
            onChange={(event) => setEndpointId(event.target.value)}
            className="h-8 cursor-pointer rounded-md border border-control bg-field px-2 text-sm focus-ring"
          >
            {model.endpoints.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label.slice(0, 80)} ({candidate.kind})
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="m-0 text-sm text-foreground-light">
          {t('connectSheet.app.endpoint')}:{' '}
          <UntrustedName name={endpoint.label} label={t('connectSheet.app.endpoint')} />
        </p>
      )}
      {built.kind === 'unsafe' ? (
        <p className="m-0 text-sm text-foreground-light">
          {t(
            built.what === 'database'
              ? 'configuration.connect.unsafe.database'
              : 'configuration.connect.unsafe.host',
          )}
        </p>
      ) : (
        <Tabs defaultValue="env">
          <TabsList aria-label={t('connectSheet.app.frameworks')}>
            {APP_FRAMEWORKS.map((framework) => (
              <TabsTrigger key={framework} value={framework}>
                {t(FRAMEWORK_LABEL[framework])}
              </TabsTrigger>
            ))}
          </TabsList>
          {APP_FRAMEWORKS.map((framework) => (
            <TabsContent key={framework} value={framework} className="mt-3">
              <Snippet
                label={t(FRAMEWORK_LABEL[framework])}
                copyLabel={t('connectSheet.app.copy', { framework: t(FRAMEWORK_LABEL[framework]) })}
                text={built.snippets[framework]}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}
      <p className="m-0 text-xs text-foreground-light">{t('connectSheet.app.note')}</p>
    </div>
  )
}

const CLI_STEPS: readonly MessageKey[] = [
  'connectSheet.cli.step.login',
  'connectSheet.cli.step.show',
  'connectSheet.cli.step.status',
  'connectSheet.cli.step.plan',
]

function CliSteps({ origin, path }: { readonly origin: string; readonly path: string }): ReactNode {
  const commands = cliCommands(origin, path)
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-foreground-light">{t('connectSheet.cli.intro')}</p>
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {CLI_STEPS.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-surface-200 text-xs tabular-nums"
            >
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="m-0 text-sm">{t(step)}</p>
              <Snippet
                label={t('connectSheet.cli.command')}
                copyLabel={t('connectSheet.cli.copy')}
                text={commands[index] ?? ''}
              />
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function McpPanel({ origin }: { readonly origin: string }): ReactNode {
  const Link = useLinkComponent()
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-foreground-light">{t('connectSheet.mcp.intro')}</p>
      <Snippet
        label={t('connectSheet.mcp.url')}
        copyLabel={t('connectSheet.mcp.url.copy')}
        text={mcpServerUrl(origin)}
      />
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-medium">{t('connectSheet.mcp.scopes')}</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t('connectSheet.mcp.scopes.column.work')}</TableHead>
              <TableHead scope="col">{t('connectSheet.mcp.scopes.column.scopes')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SCOPE_SETS.map((set) => (
              <TableRow key={set.scopes}>
                <TableCell className="text-sm">{t(set.work)}</TableCell>
                <TableCell className="font-mono text-xs">{set.scopes}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <Button asChild size="small" variant="default">
          <Link href="/connect">{t('connectSheet.mcp.setup')}</Link>
        </Button>
      </div>
    </div>
  )
}

function ApiPanel({ origin, path }: { readonly origin: string; readonly path: string }): ReactNode {
  const Link = useLinkComponent()
  const api = apiSnippets(origin, path)
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-foreground-light">{t('connectSheet.api.intro')}</p>
      <Snippet
        label={t('connectSheet.api.base')}
        copyLabel={t('connectSheet.api.copy')}
        text={api.base}
      />
      <Snippet
        label={t('connectSheet.api.curl')}
        copyLabel={t('connectSheet.api.copy')}
        text={api.curl}
      />
      <Snippet
        label={t('connectSheet.api.sdk')}
        copyLabel={t('connectSheet.api.copy')}
        text={api.sdk}
      />
      <p className="m-0 text-sm">
        <Link
          href="/access/service-accounts"
          className="text-foreground-light hover:text-foreground focus-ring"
        >
          {t('connectSheet.api.keys')}
        </Link>
      </p>
    </div>
  )
}
