import { AlertTriangle, ChevronDown, ChevronRight } from '@exponetdb/icons'
import { Button, cn, Tabs, TabsContent, TabsList, TabsTrigger } from '@exponetdb/ui'
import {
  FailedReadState,
  type HeadingLevel,
  KeyValueList,
  type NowInput,
  ObservedTime,
  type Readable,
  ReadableView,
  type ReadMeta,
  SourceLabel,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useMemo, useState } from 'react'

import {
  defaultExplainBasis,
  type ExplainBasis,
  type ExplainFieldKey,
  type ExplainNode,
  type ExplainPlan,
  type ExplainShares,
  explainShares,
  parseExplainPlan,
} from './parse-explain.ts'

const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const COST_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const TIME_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})
const PERCENT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

function formatRows(value: number): string {
  return COUNT_FORMAT.format(value)
}

function formatCost(value: number): string {
  return COST_FORMAT.format(value)
}

function formatMsValue(value: number): string {
  return TIME_FORMAT.format(value)
}

function formatMs(value: number): string {
  return `${formatMsValue(value)} ms`
}

function formatShare(share: number): string {
  return `${PERCENT_FORMAT.format(share * 100)}%`
}

/** A range such as `0.00..35.50`, or the one end that was reported. */
function range(from: number | null, to: number | null, format: (value: number) => string) {
  if (to === null) return from === null ? null : format(from)
  return from === null ? format(to) : `${format(from)}..${format(to)}`
}

/** Collapsed subtrees of a large plan: everything below the third level, except the way to the hottest node. */
const LARGE_PLAN_NODES = 300
const LARGE_PLAN_OPEN_DEPTH = 3

function initialCollapsed(plan: ExplainPlan, hottestId: string | null): ReadonlySet<string> {
  if (plan.nodes.length <= LARGE_PLAN_NODES) return new Set()
  const collapsed = new Set<string>()
  for (const node of plan.nodes) {
    if (node.children.length === 0 || node.depth < LARGE_PLAN_OPEN_DEPTH) continue
    const onTheWay = hottestId?.startsWith(`${node.id}.`)
    if (!onTheWay) collapsed.add(node.id)
  }
  return collapsed
}

interface PanelState {
  readonly plan: ExplainPlan
  readonly basis: ExplainBasis | null
  readonly collapsed: ReadonlySet<string>
}

function initialPanelState(plan: ExplainPlan): PanelState {
  const basis = defaultExplainBasis(plan)
  const hottestId = basis === null ? null : explainShares(plan, basis).hottestId
  return { plan, basis, collapsed: initialCollapsed(plan, hottestId) }
}

function NotReported(): ReactNode {
  return <span className="italic text-foreground-muted">not reported</span>
}

function NodeText({ value, mono = false }: { value: string; mono?: boolean }): ReactNode {
  return <UntrustedName name={value} mono={mono} maxCodePoints={60} />
}

function Tag({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-sm border border-default px-1 text-xs font-normal text-foreground-light">
      <span>{label}</span>
      <NodeText value={value} />
    </span>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <dt className="text-foreground-lighter">{label}</dt>
      <dd className="m-0 break-words text-foreground">{children}</dd>
    </div>
  )
}

function missingText(missing: readonly ExplainFieldKey[]): string {
  return `Not reported: ${missing.join(', ')}.`
}

interface NodeItemProps {
  readonly node: ExplainNode
  readonly plan: ExplainPlan
  readonly shares: ExplainShares | null
  readonly collapsed: ReadonlySet<string>
  readonly onToggle: (id: string) => void
}

function ExplainNodeItem({ node, plan, shares, collapsed, onToggle }: NodeItemProps): ReactNode {
  const titleId = useId()
  const childrenId = useId()
  const hasChildren = node.children.length > 0
  const open = !collapsed.has(node.id)
  const hot = shares !== null && shares.hottestId === node.id
  const share = shares?.byNode.get(node.id) ?? null
  const missing = plan.notReportedByNode.get(node.id) ?? []

  const cost = range(node.startupCost, node.totalCost, formatCost)
  const timeRange = range(node.actualStartupTime, node.actualTotalTime, formatMsValue)
  const time = timeRange === null ? null : `${timeRange} ms`
  const bufferText = node.buffers
    .filter((figure) => figure.value !== 0)
    .map((figure) => `${figure.label}=${formatRows(figure.value)}`)
    .join(', ')

  return (
    <li>
      <div
        data-node-id={node.id}
        data-hottest={hot ? 'true' : undefined}
        className={cn(
          'rounded-md border bg-surface-100 p-2',
          hot ? 'border-warning-500 bg-warning-200/40' : 'border-default',
        )}
      >
        <div className="flex items-start gap-2">
          {hasChildren ? (
            <Button
              type="button"
              variant="text"
              size="tiny"
              aria-expanded={open}
              aria-controls={childrenId}
              aria-labelledby={titleId}
              onClick={() => onToggle(node.id)}
              icon={
                open ? (
                  <ChevronDown aria-hidden="true" className="size-4" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-4" />
                )
              }
            />
          ) : (
            <span aria-hidden="true" className="inline-block w-[26px] shrink-0" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              id={titleId}
              className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm font-medium text-foreground"
            >
              {node.nodeType === null ? (
                <span className="italic text-foreground-muted">node type not reported</span>
              ) : (
                <NodeText value={node.nodeType} />
              )}
              {node.relationName !== null && (
                <>
                  <span className="font-normal text-foreground-lighter">on</span>
                  <span className="inline-flex items-baseline">
                    {node.schema !== null && (
                      <>
                        <NodeText value={node.schema} mono />
                        <span aria-hidden="true">.</span>
                      </>
                    )}
                    <NodeText value={node.relationName} mono />
                  </span>
                </>
              )}
              {node.alias !== null && node.alias !== node.relationName && (
                <>
                  <span className="font-normal text-foreground-lighter">as</span>
                  <NodeText value={node.alias} mono />
                </>
              )}
              {node.indexName !== null && (
                <>
                  <span className="font-normal text-foreground-lighter">using</span>
                  <NodeText value={node.indexName} mono />
                </>
              )}
              {node.cteName !== null && <Tag label="CTE" value={node.cteName} />}
              {node.subplanName !== null && <Tag label="Subplan" value={node.subplanName} />}
              {node.joinType !== null && <Tag label="Join" value={node.joinType} />}
              {node.strategy !== null && <Tag label="Strategy" value={node.strategy} />}
              {node.scanDirection !== null && <Tag label="Scan" value={node.scanDirection} />}
              {hot && (
                <span className="inline-flex items-center gap-1 rounded-sm border border-warning-500 bg-warning-200 px-1 text-xs font-medium text-warning-600">
                  <AlertTriangle aria-hidden="true" className="size-3" />
                  Most expensive
                </span>
              )}
              {node.actualLoops === 0 && (
                <span className="rounded-sm border border-default px-1 text-xs font-normal text-foreground-light">
                  Never executed
                </span>
              )}
            </span>

            {shares !== null && share !== null && (
              <div className="flex items-center gap-2 text-xs text-foreground-light">
                <div
                  aria-hidden="true"
                  className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-surface-300"
                >
                  <div
                    className={cn('h-full rounded-full', hot ? 'bg-warning-500' : 'bg-primary-500')}
                    style={{ width: `${share > 0 ? Math.max(share * 100, 0.5) : 0}%` }}
                  />
                </div>
                <span>{`${formatShare(share)} of the plan's own ${shares.basis}`}</span>
              </div>
            )}

            <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-1 text-xs">
              {node.planRows !== null && (
                <Fact label="Estimated rows">{formatRows(node.planRows)}</Fact>
              )}
              {node.actualRows !== null && (
                <Fact label="Actual rows">
                  {`${formatRows(node.actualRows)}${node.actualLoops !== null && node.actualLoops > 1 ? ' per loop' : ''}`}
                </Fact>
              )}
              {node.actualLoops !== null && (
                <Fact label="Loops">{formatRows(node.actualLoops)}</Fact>
              )}
              {cost !== null && <Fact label="Cost (startup..total)">{cost}</Fact>}
              {time !== null && <Fact label="Time (startup..total)">{time}</Fact>}
              {node.ownTime !== null && <Fact label="Own time">{formatMs(node.ownTime)}</Fact>}
              {node.ownCost !== null && <Fact label="Own cost">{formatCost(node.ownCost)}</Fact>}
              {node.buffersReported && (
                <Fact label="Buffers">{bufferText === '' ? 'none used' : bufferText}</Fact>
              )}
              {node.counts.map((figure) => (
                <Fact key={figure.label} label={figure.label}>
                  {formatRows(figure.value)}
                </Fact>
              ))}
            </dl>

            {node.estimateMiss !== null && (
              <p className="m-0 flex items-center gap-1 text-xs text-warning-600">
                <AlertTriangle aria-hidden="true" className="size-3" />
                {`Row estimate is ${formatRows(node.estimateMiss.factor)}x too ${node.estimateMiss.direction}.`}
              </p>
            )}

            {missing.length > 0 && (
              <p className="m-0 text-xs italic text-foreground-lighter">{missingText(missing)}</p>
            )}

            {node.details.length > 0 && (
              <dl className="m-0 flex flex-col gap-1 text-xs">
                {node.details.map((detail) => (
                  <div key={detail.label} className="min-w-0">
                    <dt className="text-foreground-lighter">{detail.label}</dt>
                    <dd className="m-0">
                      <UntrustedText
                        text={detail.text}
                        mono
                        maxLines={4}
                        maxCodePoints={400}
                        label={detail.label.toLowerCase()}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      </div>
      {hasChildren && open && (
        <ul
          id={childrenId}
          className="m-0 mt-2 ml-3 flex list-none flex-col gap-2 border-l border-default pl-3"
        >
          {node.children.map((child) => (
            <ExplainNodeItem
              key={child.id}
              node={child}
              plan={plan}
              shares={shares}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function basisLabel(basis: ExplainBasis): string {
  return basis === 'time' ? 'Time' : 'Cost'
}

interface PlanPanelProps {
  readonly plan: ExplainPlan
  readonly meta: ReadMeta
  readonly now?: NowInput
  readonly current: PanelState
  readonly setState: (next: PanelState) => void
}

function PlanPanel({ plan, meta, now, current, setState }: PlanPanelProps): ReactNode {
  const { basis, collapsed } = current
  const shares = useMemo(() => (basis === null ? null : explainShares(plan, basis)), [plan, basis])

  const toggle = (id: string) => {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setState({ ...current, collapsed: next })
  }
  const expandAll = () => setState({ ...current, collapsed: new Set() })
  const collapseAll = () =>
    setState({
      ...current,
      collapsed: new Set(plan.nodes.filter((node) => node.children.length > 0).map((n) => n.id)),
    })

  const summary = [
    {
      id: 'planning',
      label: 'Planning time',
      value: plan.planningTime === null ? <NotReported /> : formatMs(plan.planningTime),
    },
    {
      id: 'execution',
      label: 'Execution time',
      value: plan.executionTime === null ? <NotReported /> : formatMs(plan.executionTime),
    },
    { id: 'nodes', label: 'Plan nodes', value: formatRows(plan.nodes.length) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-foreground-light">
        <SourceLabel source={meta.source} />
        <span>
          Observed <ObservedTime observedAt={meta.observedAt} withDate now={now} />
        </span>
      </p>

      <KeyValueList items={summary} />

      {plan.triggers.length > 0 && (
        <div className="text-sm">
          <p className="m-0 text-foreground-lighter">Triggers</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {plan.triggers.map((trigger, index) => (
              <li
                // The trigger list has no identity of its own; its order is the plan's.
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the only identity a trigger entry has
                key={index}
                className="flex flex-wrap items-baseline gap-x-2 text-foreground"
              >
                {trigger.name === null ? <NotReported /> : <NodeText value={trigger.name} />}
                {trigger.relation !== null && (
                  <>
                    <span className="text-foreground-lighter">on</span>
                    <NodeText value={trigger.relation} mono />
                  </>
                )}
                <span className="text-foreground-light">
                  {trigger.time === null ? 'time not reported' : formatMs(trigger.time)}
                  {trigger.calls === null ? '' : `, ${formatRows(trigger.calls)} calls`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.extraPlans > 0 && (
        <p className="m-0 text-sm text-foreground-light">
          {`The result holds ${formatRows(plan.extraPlans)} more ${plan.extraPlans === 1 ? 'plan' : 'plans'}; only the first is drawn. The others are in the raw JSON.`}
        </p>
      )}

      {plan.problems.length > 0 && (
        <div
          role="note"
          className="rounded-md border border-warning-500 bg-warning-200 p-2 text-sm text-warning-600"
        >
          <p className="m-0 flex items-center gap-1 font-medium">
            <AlertTriangle aria-hidden="true" className="size-4" />
            Part of the plan is not shown
          </p>
          <ul className="m-0 list-disc pl-5">
            {plan.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {plan.notReportedAnywhere.length > 0 && (
        <p className="m-0 text-sm text-foreground-light">
          {`${missingText(plan.notReportedAnywhere)}${
            plan.notReportedAnywhere.some((field) => field === 'time' || field === 'actual rows')
              ? ' Run EXPLAIN with ANALYZE to see actual rows and time.'
              : ''
          }`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {basis === null ? (
          <p className="m-0 text-foreground-light">
            Bars are not drawn: the plan does not report a time or a cost for every node.
          </p>
        ) : plan.timeAvailable && plan.costAvailable ? (
          <fieldset className="m-0 flex items-center gap-2 border-0 p-0">
            <legend className="sr-only">Bars show</legend>
            <span aria-hidden="true" className="text-foreground-lighter">
              Bars show
            </span>
            {(['time', 'cost'] as const).map((option) => (
              <Button
                key={option}
                type="button"
                size="tiny"
                variant={basis === option ? 'default' : 'outline'}
                aria-pressed={basis === option}
                onClick={() => setState({ ...current, basis: option })}
              >
                {basisLabel(option)}
              </Button>
            ))}
          </fieldset>
        ) : (
          <p className="m-0 text-foreground-light">
            {`Bars show each node's own ${basis}, not counting its children.`}
          </p>
        )}
        <span className="grow" />
        <Button type="button" size="tiny" variant="outline" onClick={expandAll}>
          Expand all
        </Button>
        <Button type="button" size="tiny" variant="outline" onClick={collapseAll}>
          Collapse all
        </Button>
      </div>

      <ul aria-label="Plan nodes" className="m-0 flex list-none flex-col gap-2 p-0">
        <ExplainNodeItem
          node={plan.root}
          plan={plan}
          shares={shares}
          collapsed={collapsed}
          onToggle={toggle}
        />
      </ul>
    </div>
  )
}

/** The pretty-printed JSON, or `null` when the value cannot be written as JSON. */
function prettyJson(value: unknown): string | null {
  try {
    return JSON.stringify(value, null, 2) ?? null
  } catch {
    return null
  }
}

function RawJson({ value }: { value: unknown }): ReactNode {
  // Written only while this tab is shown: a large plan costs nothing until it is asked for.
  const text = useMemo(() => prettyJson(value), [value])
  if (text === null) {
    return <p className="m-0 text-sm text-foreground-light">The plan cannot be written as JSON.</p>
  }
  return <UntrustedText text={text} mono maxLines={400} maxCodePoints={50_000} label="plan JSON" />
}

interface ExplainReadyProps {
  readonly value: unknown
  readonly meta: ReadMeta
  readonly what: string
  readonly now?: NowInput
  readonly headingLevel?: HeadingLevel
}

function ExplainReady({ value, meta, what, now, headingLevel }: ExplainReadyProps): ReactNode {
  const parsed = useMemo(() => parseExplainPlan(value), [value])
  if (!parsed.ok) {
    return (
      <FailedReadState
        what={what}
        error={{ code: 'INVALID_PLAN', message: parsed.reason }}
        headingLevel={headingLevel}
      />
    )
  }
  return <ExplainTabs plan={parsed.plan} raw={value} meta={meta} now={now} />
}

interface ExplainTabsProps {
  readonly plan: ExplainPlan
  readonly raw: unknown
  readonly meta: ReadMeta
  readonly now?: NowInput
}

function ExplainTabs({ plan, raw, meta, now }: ExplainTabsProps): ReactNode {
  // The folds and the choice of bars live above the tabs, so they survive a visit to the other tab.
  const [state, setState] = useState<PanelState>(() => initialPanelState(plan))
  // A different plan starts from its own defaults, not from the previous plan's folds.
  const current = state.plan === plan ? state : initialPanelState(plan)
  if (current !== state) setState(current)

  return (
    <Tabs defaultValue="plan">
      <TabsList aria-label="Plan views" className="gap-4">
        <TabsTrigger value="plan">Plan</TabsTrigger>
        <TabsTrigger value="raw">Raw JSON</TabsTrigger>
      </TabsList>
      <TabsContent value="plan">
        <PlanPanel plan={plan} meta={meta} now={now} current={current} setState={setState} />
      </TabsContent>
      <TabsContent value="raw">
        <RawJson value={raw} />
      </TabsContent>
    </Tabs>
  )
}

export interface ExplainViewProps {
  /**
   * The JSON the server returned for `EXPLAIN (FORMAT JSON)`: the parsed array
   * `[ { "Plan": ... } ]`, as data. It is `unknown` on purpose; the view
   * validates it and shows a failed read with the reason when it is not a plan.
   */
  plan: Readable<unknown>
  /** What is shown, as a noun phrase that works after "no". Default "query plan". */
  what?: string
  onRetry?: () => void
  onRefresh?: () => void
  busy?: boolean
  now?: NowInput
  headingLevel?: HeadingLevel
  className?: string
}

/**
 * An `EXPLAIN (FORMAT JSON)` plan as a tree of nodes (C-26, C-28): node type,
 * relation, index, join type, estimated and actual rows, loops, startup and
 * total cost, actual time and buffers, with a bar for each node's share of the
 * plan's own time (or cost, when time is not reported) and the most expensive
 * node marked in words. Subtrees fold. Every string from the plan is untrusted
 * text; a field the plan does not report is "not reported"; a result that is
 * not a plan is a failed read with the reason. A second tab shows the JSON.
 */
export function ExplainView({
  plan,
  what = 'query plan',
  onRetry,
  onRefresh,
  busy,
  now,
  headingLevel,
  className,
}: ExplainViewProps): ReactNode {
  return (
    <div className={className}>
      <ReadableView
        readable={plan}
        what={what}
        onRetry={onRetry}
        onRefresh={onRefresh}
        busy={busy}
        now={now}
        headingLevel={headingLevel}
        ready={(value, meta) => (
          <ExplainReady
            value={value}
            meta={meta}
            what={what}
            now={now}
            headingLevel={headingLevel}
          />
        )}
      />
    </div>
  )
}
