import { Badge, Button, Input, Label } from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'
import type { DemoDefinition } from '../types.ts'
import { SwatchList, type SwatchSpec } from './swatch.tsx'

// Every class below is written out in full: the swatches are painted by the utilities the
// components use, never by a literal color.

const SURFACES: readonly SwatchSpec[] = [
  {
    token: '--background',
    utility: 'bg-background',
    className: 'bg-background text-foreground',
    use: 'The page',
    sample: 'Aa',
  },
  {
    token: '--card',
    utility: 'bg-card',
    className: 'bg-card text-foreground',
    use: 'Cards and panels (same as bg-surface-100)',
    sample: 'Aa',
  },
  {
    token: '--muted',
    utility: 'bg-muted',
    className: 'bg-muted text-foreground',
    use: 'Quiet fills, row hover (bg-surface-200)',
    sample: 'Aa',
  },
  {
    token: '--secondary',
    utility: 'bg-secondary',
    className: 'bg-secondary text-foreground',
    use: 'Raised plates (bg-surface-300)',
    sample: 'Aa',
  },
  {
    token: '--tertiary',
    utility: 'bg-tertiary',
    className: 'bg-tertiary text-foreground',
    use: 'The strongest neutral fill (bg-surface-400)',
    sample: 'Aa',
  },
  {
    token: '--popover',
    utility: 'bg-popover',
    className: 'bg-popover text-popover-foreground',
    use: 'Popovers and sheets',
    sample: 'Aa',
  },
  {
    token: '--background-overlay-default',
    utility: 'bg-overlay',
    className: 'bg-overlay text-foreground',
    use: 'Menus, select lists, hover cards',
    sample: 'Aa',
  },
  {
    token: '--accent',
    utility: 'bg-accent',
    className: 'bg-accent text-accent-foreground',
    use: 'Neutral hover and selection (bg-selection)',
    sample: 'Aa',
  },
]

const FILLS: readonly SwatchSpec[] = [
  {
    token: '--primary',
    utility: 'bg-primary',
    className: 'bg-primary text-primary-foreground',
    use: 'The spot color: small indicators and link ink',
    sample: 'Aa',
  },
  {
    token: '--primary-solid',
    utility: 'bg-primary-solid',
    className: 'bg-primary-solid text-primary-solid-foreground',
    use: 'The plate of the primary button',
    sample: 'Aa',
  },
  {
    token: '--primary-bright',
    utility: 'bg-primary-bright',
    className: 'bg-primary-bright text-primary-foreground',
    use: 'Switch fill, selected chrome, the focus ring',
    sample: 'Aa',
  },
  {
    token: '--success',
    utility: 'bg-success',
    className: 'bg-success text-success-foreground',
    use: 'A completed or verified result',
    sample: 'Aa',
  },
  {
    token: '--warning',
    utility: 'bg-warning',
    className: 'bg-warning text-warning-foreground',
    use: 'Something to read before going on',
    sample: 'Aa',
  },
  {
    token: '--destructive',
    utility: 'bg-destructive',
    className: 'bg-destructive text-destructive-foreground',
    use: 'An error or an action that destroys',
    sample: 'Aa',
  },
  {
    token: '--info',
    utility: 'bg-info',
    className: 'bg-info text-info-foreground',
    use: 'A neutral notice',
    sample: 'Aa',
  },
]

const CHART_SLOTS: readonly SwatchSpec[] = [
  {
    token: '--chart-1',
    utility: 'bg-chart-1',
    className: 'bg-chart-1',
    use: 'Slot 1 (the spot color)',
  },
  { token: '--chart-2', utility: 'bg-chart-2', className: 'bg-chart-2', use: 'Slot 2' },
  { token: '--chart-3', utility: 'bg-chart-3', className: 'bg-chart-3', use: 'Slot 3' },
  { token: '--chart-4', utility: 'bg-chart-4', className: 'bg-chart-4', use: 'Slot 4' },
  { token: '--chart-5', utility: 'bg-chart-5', className: 'bg-chart-5', use: 'Slot 5' },
  { token: '--chart-6', utility: 'bg-chart-6', className: 'bg-chart-6', use: 'Slot 6' },
  { token: '--chart-7', utility: 'bg-chart-7', className: 'bg-chart-7', use: 'Slot 7' },
  { token: '--chart-8', utility: 'bg-chart-8', className: 'bg-chart-8', use: 'Slot 8' },
]

const CHART_FILLS: readonly SwatchSpec[] = [
  {
    token: '--chart-1-fill',
    utility: 'bg-chart-1-fill',
    className: 'bg-chart-1-fill',
    use: 'Area under slot 1 (25 percent)',
  },
  {
    token: '--chart-2-fill',
    utility: 'bg-chart-2-fill',
    className: 'bg-chart-2-fill',
    use: 'Area under slot 2 (25 percent)',
  },
]

function Block({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <p className="text-xs font-medium text-foreground-light">{title}</p>
      {children}
    </section>
  )
}

function Surfaces(): ReactNode {
  return <SwatchList items={SURFACES} label="Surfaces" />
}

function TextTiers(): ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(
        [
          { name: 'On the page', surface: 'bg-background' },
          { name: 'On a card', surface: 'bg-card' },
        ] as const
      ).map((row) => (
        <div
          key={row.name}
          className={`${row.surface} flex flex-col gap-1 rounded-md border border-default p-4`}
        >
          <p className="text-xs text-foreground-light">{row.name}</p>
          <p className="text-sm text-foreground">text-foreground: body text and headings</p>
          <p className="text-sm text-foreground-light">text-foreground-light: secondary text</p>
          <p className="text-sm text-foreground-lighter">
            text-foreground-lighter: hints and placeholders
          </p>
          <p className="text-sm text-primary">text-primary: links and the spot color as ink</p>
          <p className="text-sm text-destructive">text-destructive: an error message</p>
          <p className="rounded-sm bg-foreground px-2 py-1 text-sm text-background">
            bg-foreground with text-background: an inverted fill
          </p>
        </div>
      ))}
    </div>
  )
}

const BORDERS = [
  { utility: 'border-default', className: 'border-default', use: 'Hairline between regions' },
  { utility: 'border-overlay', className: 'border-overlay', use: 'Edge of a menu or popover' },
  { utility: 'border-strong', className: 'border-strong', use: 'Quiet emphasis' },
  { utility: 'border-stronger', className: 'border-stronger', use: 'Strong emphasis' },
  {
    utility: 'border-control',
    className: 'border-control',
    use: 'The boundary of a control',
  },
  {
    utility: 'border-control-hover',
    className: 'border-control-hover',
    use: 'A control under the pointer',
  },
] as const

function Borders(): ReactNode {
  return (
    <ul aria-label="Borders" className="grid gap-3 sm:grid-cols-2">
      {BORDERS.map((border) => (
        <li key={border.utility} className="flex items-center gap-3">
          <span
            aria-hidden
            className={`h-10 w-14 shrink-0 rounded-md border-2 bg-background ${border.className}`}
          />
          <span className="min-w-0 text-sm">
            <code className="font-mono text-xs text-foreground">{border.utility}</code>
            <span className="block text-foreground-light">{border.use}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function Fills(): ReactNode {
  return <SwatchList items={FILLS} label="Fills with their foreground" />
}

const SCALES = [
  {
    name: 'primary',
    steps: [
      'bg-primary-200',
      'bg-primary-300',
      'bg-primary-400',
      'bg-primary-500',
      'bg-primary-200 text-primary-600',
    ],
  },
  {
    name: 'success',
    steps: [
      'bg-success-200',
      'bg-success-300',
      'bg-success-400',
      'bg-success-500',
      'bg-success-200 text-success-600',
    ],
  },
  {
    name: 'warning',
    steps: [
      'bg-warning-200',
      'bg-warning-300',
      'bg-warning-400',
      'bg-warning-500',
      'bg-warning-200 text-warning-600',
    ],
  },
  {
    name: 'destructive',
    steps: [
      'bg-destructive-200',
      'bg-destructive-300',
      'bg-destructive-400',
      'bg-destructive-500',
      'bg-destructive-200 text-destructive-600',
    ],
  },
] as const

const SCALE_LABELS = ['200', '300', '400', '500', '600 as text'] as const

function Scales(): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {SCALES.map((scale) => (
        <div key={scale.name} className="flex flex-col gap-1">
          <p className="font-mono text-xs text-foreground-light">{scale.name}</p>
          <ul aria-label={`${scale.name} scale`} className="flex gap-2">
            {scale.steps.map((step, index) => (
              <li key={step} className="flex flex-col items-center gap-1">
                <span
                  aria-hidden
                  className={`flex h-10 w-16 items-center justify-center rounded-md border border-default text-sm font-medium ${step}`}
                >
                  {index === 4 ? 'Aa' : ''}
                </span>
                <span className="text-xs text-foreground-light">{SCALE_LABELS[index]}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function Charts(): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <SwatchList items={CHART_SLOTS} label="Chart slots" />
      <SwatchList items={CHART_FILLS} label="Chart fills" />
    </div>
  )
}

function Panel(): ReactNode {
  const nameId = useId()
  return (
    <div className="flex max-w-md flex-col gap-4 rounded-lg border border-default bg-card p-4 text-card-foreground">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Register target</p>
        <Badge variant="success">Verified</Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={nameId} className="text-foreground-light">
          Target path
        </Label>
        <Input id={nameId} defaultValue="shop/platform/staging" />
        <p className="text-xs text-foreground-lighter">Product, project and environment.</p>
      </div>
      <p className="rounded-md border border-destructive-400 bg-destructive-200 px-3 py-2 text-sm text-foreground">
        <span className="text-destructive-600">Could not reach the server.</span> The error code is
        SERVICE_UNAVAILABLE.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="default">Cancel</Button>
        <Button variant="primary">Register target</Button>
      </div>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'tokens/colors/surfaces',
    title: 'Surfaces from the page up to the overlay',
    render: () => (
      <Block title="Each surface with the text color that goes on it">
        <Surfaces />
      </Block>
    ),
  },
  {
    id: 'tokens/colors/text',
    title: 'Text tiers on the page and on a card',
    render: () => <TextTiers />,
  },
  {
    id: 'tokens/colors/borders',
    title: 'Hairlines and control boundaries',
    render: () => <Borders />,
  },
  {
    id: 'tokens/colors/fills',
    title: 'Fills and the text that goes on them',
    render: () => <Fills />,
  },
  {
    id: 'tokens/colors/scales',
    title: 'Stepped scales for tinted surfaces',
    render: () => <Scales />,
  },
  {
    id: 'tokens/colors/charts',
    title: 'Chart slots 1 to 8',
    render: () => <Charts />,
  },
  {
    id: 'tokens/colors/composed',
    title: 'A panel built only from semantic tokens',
    render: () => <Panel />,
  },
]
