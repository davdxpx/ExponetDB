// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/chart.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import * as React from 'react'
import * as RechartsPrimitive from 'recharts'

import { cn } from './lib/utils.ts'

/** The chart color slots the tokens define: `--chart-1` to `--chart-8` (design-system.md §2). */
export const CHART_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const
export type ChartSlot = (typeof CHART_SLOTS)[number]

/**
 * A series color is a reference to a token slot, never a literal color. The slots resolve per
 * theme in the token CSS, so a chart needs no light and dark pair of its own.
 */
export type ChartColor = `var(--chart-${ChartSlot})`

/** The color of slot `slot` (1 to 8). */
export function chartColor(slot: ChartSlot): ChartColor {
  return `var(--chart-${slot})`
}

export type ChartConfig = {
  [key: string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
    color?: ChartColor
  }
}

const CHART_COLOR_PATTERN = /^var\(--chart-[1-8]\)$/
// A config key becomes part of a custom property name: only identifier characters qualify.
const CHART_KEY_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * The CSS custom properties `--color-<key>` of a chart config, as a style object. The chart
 * container sets them through its `style` prop (a CSSOM write), so no `<style>` element is
 * created and a strict `style-src` stays valid. Entries whose key is not an identifier or whose
 * color is not a chart slot reference are left out: a color that came from data never reaches
 * the document.
 */
export function getChartStyle(config: ChartConfig): React.CSSProperties {
  const properties: Record<string, string> = {}
  for (const [key, item] of Object.entries(config)) {
    const color: string | undefined = item.color
    if (color !== undefined && CHART_KEY_PATTERN.test(key) && CHART_COLOR_PATTERN.test(color)) {
      properties[`--color-${key}`] = color
    }
  }
  // Custom properties are valid style keys that CSSProperties does not list.
  return properties as React.CSSProperties
}

type ChartContextProps = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />')
  }

  return context
}

const ChartContainer = React.forwardRef<
  HTMLDivElement,
  Omit<React.ComponentProps<'div'>, 'children'> & {
    config?: ChartConfig
    children: React.ReactNode
    /** Size used until the container is measured (and always where nothing measures, as in tests). */
    initialDimension?: { width: number; height: number }
  }
>(
  (
    {
      id,
      className,
      children,
      config = {},
      style,
      initialDimension = { width: 320, height: 200 },
      ...props
    },
    ref,
  ) => {
    const uniqueId = React.useId()
    const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`
    const contextValue = React.useMemo(() => ({ config }), [config])
    const colorStyle = React.useMemo(() => getChartStyle(config), [config])

    return (
      <ChartContext.Provider value={contextValue}>
        <div
          data-chart={chartId}
          ref={ref}
          className={cn(
            "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-foreground-muted [&_.recharts-cartesian-grid_line]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line-line]:stroke-foreground [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden",
            className,
          )}
          style={{ ...colorStyle, ...style }}
          {...props}
        >
          <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>
            {children}
          </RechartsPrimitive.ResponsiveContainer>
        </div>
      </ChartContext.Provider>
    )
  },
)
ChartContainer.displayName = 'Chart'

/**
 * A line that never draws across a missing value: a `null` or `undefined` observation is a gap,
 * not something to interpolate (truthful reads). `connectNulls` is fixed and cannot be set.
 */
function GapLine(props: Omit<React.ComponentProps<typeof RechartsPrimitive.Line>, 'connectNulls'>) {
  return <RechartsPrimitive.Line {...props} connectNulls={false} />
}

/** An area that breaks at a missing value, like `GapLine`. */
function GapArea(props: Omit<React.ComponentProps<typeof RechartsPrimitive.Area>, 'connectNulls'>) {
  return <RechartsPrimitive.Area {...props} connectNulls={false} />
}

const ChartTooltip = RechartsPrimitive.Tooltip

type TooltipItem = RechartsPrimitive.TooltipPayloadEntry

function readText(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null || !(key in source)) {
    return undefined
  }
  const value: unknown = (source as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function dataKeyText(dataKey: TooltipItem['dataKey']): string | undefined {
  return typeof dataKey === 'string' || typeof dataKey === 'number' ? String(dataKey) : undefined
}

function formatValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'number') {
    return value.toLocaleString()
  }
  if (Array.isArray(value)) {
    return value.map((part) => String(part)).join(' to ')
  }
  return String(value)
}

type ChartTooltipContentProps = Partial<
  Pick<
    RechartsPrimitive.TooltipContentProps,
    'active' | 'payload' | 'label' | 'labelFormatter' | 'formatter' | 'labelClassName'
  >
> &
  Pick<React.ComponentProps<'div'>, 'className'> & {
    hideLabel?: boolean
    hideIndicator?: boolean
    indicator?: 'line' | 'dot' | 'dashed'
    /** Indicator color; defaults to the color of the series. */
    color?: string
    nameKey?: string
    labelKey?: string
    labelSuffix?: string
  }

const ChartTooltipContent = React.forwardRef<HTMLDivElement, ChartTooltipContentProps>(
  (
    {
      active,
      payload,
      className,
      indicator = 'dot',
      hideLabel = false,
      hideIndicator = false,
      label,
      labelFormatter,
      labelSuffix,
      labelClassName,
      formatter,
      color,
      nameKey,
      labelKey,
    },
    ref,
  ) => {
    const { config } = useChart()

    const tooltipLabel = React.useMemo(() => {
      const [item] = payload ?? []
      if (hideLabel || item === undefined) {
        return null
      }

      const key = `${labelKey || dataKeyText(item.dataKey) || item.name || 'value'}`
      const itemConfig = getPayloadConfigFromPayload(config, item, key)
      const value =
        !labelKey && typeof label === 'string' ? config[label]?.label || label : itemConfig?.label

      if (labelFormatter && payload) {
        return (
          <div className={cn('font-medium', labelClassName)}>{labelFormatter(value, payload)}</div>
        )
      }

      if (!value) {
        return null
      }

      return <div className={cn('font-medium', labelClassName)}>{value}</div>
    }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey])

    if (!active || !payload?.length) {
      return null
    }

    const nestLabel = payload.length === 1 && indicator !== 'dot'

    return (
      <div
        ref={ref}
        className={cn(
          'grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-default px-2.5 py-1.5 text-xs shadow-xl',
          className,
        )}
      >
        {!nestLabel ? tooltipLabel : null}
        <div className="grid gap-1.5">
          {payload.map((item, index) => {
            const key = `${nameKey || item.name || dataKeyText(item.dataKey) || 'value'}`
            const itemConfig = getPayloadConfigFromPayload(config, item, key)
            const indicatorColor = color || readText(item.payload, 'fill') || item.color
            const valueText = formatValue(item.value)

            return (
              <div
                key={`${item.graphicalItemId}-${item.name ?? ''}`}
                className={cn(
                  'flex w-full items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-foreground-muted',
                  indicator === 'dot' && 'items-center',
                )}
              >
                {formatter && item.value !== undefined && item.name !== undefined ? (
                  formatter(item.value, item.name, item, index, payload)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <div
                          aria-hidden="true"
                          className={cn(
                            'shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)',
                            {
                              'h-2.5 w-2.5': indicator === 'dot',
                              'w-1': indicator === 'line',
                              'w-0 border-[1.5px] border-dashed bg-transparent':
                                indicator === 'dashed',
                              'my-0.5': nestLabel && indicator === 'dashed',
                            },
                          )}
                          style={
                            {
                              '--color-bg': indicatorColor,
                              '--color-border': indicatorColor,
                            } as React.CSSProperties
                          }
                        />
                      )
                    )}
                    <div
                      className={cn(
                        'flex flex-1 justify-between leading-none',
                        nestLabel ? 'items-end' : 'items-center',
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-foreground-light">
                          {itemConfig?.label || item.name}
                        </span>
                      </div>
                      {valueText !== null && (
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {valueText}
                          {labelSuffix}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  },
)
ChartTooltipContent.displayName = 'ChartTooltip'

const ChartLegend = RechartsPrimitive.Legend

type ChartLegendContentProps = Pick<React.ComponentProps<'div'>, 'className'> &
  Pick<RechartsPrimitive.DefaultLegendContentProps, 'payload' | 'verticalAlign'> & {
    hideIcon?: boolean
    nameKey?: string
  }

const ChartLegendContent = React.forwardRef<HTMLDivElement, ChartLegendContentProps>(
  ({ className, hideIcon = false, payload, verticalAlign = 'bottom', nameKey }, ref) => {
    const { config } = useChart()

    if (!payload?.length) {
      return null
    }

    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-center gap-4',
          verticalAlign === 'top' ? 'pb-3' : 'pt-3',
          className,
        )}
      >
        {payload.map((item) => {
          const key = `${nameKey || dataKeyText(item.dataKey) || 'value'}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)

          return (
            <div
              key={`${item.value ?? ''}-${dataKeyText(item.dataKey) ?? ''}`}
              className="flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-foreground-muted"
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{
                    backgroundColor: item.color,
                  }}
                />
              )}
              {itemConfig?.label ?? item.value}
            </div>
          )
        })}
      </div>
    )
  },
)
ChartLegendContent.displayName = 'ChartLegend'

// Helper to extract item config from a payload.
function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null) {
    return undefined
  }

  const payloadPayload =
    'payload' in payload && typeof payload.payload === 'object' && payload.payload !== null
      ? payload.payload
      : undefined

  let configLabelKey: string = key

  const own = readText(payload, key)
  const nested = readText(payloadPayload, key)
  if (own !== undefined) {
    configLabelKey = own
  } else if (nested !== undefined) {
    configLabelKey = nested
  }

  return configLabelKey in config ? config[configLabelKey] : config[key]
}

export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  GapArea,
  GapLine,
}
