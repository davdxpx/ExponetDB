import { Plus } from '@exponetdb/icons'
import { Button, ComboboxTrigger, Input } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

const SPACING = [
  { cls: 'w-1', px: '4 px' },
  { cls: 'w-2', px: '8 px' },
  { cls: 'w-3', px: '12 px' },
  { cls: 'w-4', px: '16 px' },
  { cls: 'w-6', px: '24 px' },
  { cls: 'w-8', px: '32 px' },
  { cls: 'w-12', px: '48 px' },
  { cls: 'w-16', px: '64 px' },
] as const

function Spacing(): ReactNode {
  return (
    <ul aria-label="Spacing steps" className="flex flex-col gap-2">
      {SPACING.map((step) => (
        <li key={step.cls} className="flex items-center gap-3">
          <span className="w-24 font-mono text-xs text-foreground-light">
            {step.cls.replace('w-', '')} = {step.px}
          </span>
          <span aria-hidden className={`h-3 rounded-sm bg-primary-bright ${step.cls}`} />
        </li>
      ))}
    </ul>
  )
}

const RADII = [
  { cls: 'rounded-sm', use: '4 px: checkboxes, small chips' },
  { cls: 'rounded-md', use: '6 px: buttons, inputs, menus, tooltips' },
  { cls: 'rounded-item', use: '4 px: items inside a menu (rounded-md minus 2 px)' },
  { cls: 'rounded-panel', use: '6 px: panels' },
  { cls: 'rounded-lg', use: '8 px: cards, alerts, dialogs' },
  { cls: 'rounded-xl', use: '12 px: inset layout surfaces' },
  { cls: 'rounded-full', use: 'Pills, badges, switches, avatars' },
] as const

function Radii(): ReactNode {
  return (
    <ul aria-label="Corner radii" className="grid gap-3 sm:grid-cols-2">
      {RADII.map((radius) => (
        <li key={radius.cls} className="flex items-center gap-3">
          <span
            aria-hidden
            className={`h-12 w-16 shrink-0 border-2 border-control bg-card ${radius.cls}`}
          />
          <span className="min-w-0 text-sm">
            <code className="font-mono text-xs text-foreground">{radius.cls}</code>
            <span className="block text-foreground-light">{radius.use}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function ControlHeights(): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {(['tiny', 'small', 'medium', 'large'] as const).map((size) => (
        <div key={size} className="flex flex-wrap items-center gap-3">
          <span className="w-16 font-mono text-xs text-foreground-light">{size}</span>
          <Button size={size} variant="primary" icon={<Plus />}>
            Create plan
          </Button>
          <Input
            size={size}
            defaultValue="shop/platform"
            aria-label={`Path, ${size} input`}
            className="w-44"
          />
          <ComboboxTrigger size={size} aria-label={`Environment, ${size} trigger`} className="w-40">
            staging
          </ComboboxTrigger>
        </div>
      ))}
    </div>
  )
}

function HitArea(): ReactNode {
  return (
    <div className="flex items-center gap-8">
      <div className="flex flex-col items-start gap-2">
        <p className="text-xs text-foreground-light">
          hit-area-debug hit-area-3 draws the extra area
        </p>
        <button
          type="button"
          aria-label="Add target"
          className="hit-area-debug hit-area-3 flex size-6 items-center justify-center rounded-md border border-control focus-ring"
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-col items-start gap-2">
        <p className="text-xs text-foreground-light">The same control as it ships</p>
        <button
          type="button"
          aria-label="Add target"
          className="hit-area-3 flex size-6 items-center justify-center rounded-md border border-control focus-ring"
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'tokens/spacing-and-radius/spacing',
    title: 'Spacing steps on the 4 px grid',
    render: () => <Spacing />,
  },
  {
    id: 'tokens/spacing-and-radius/radius',
    title: 'Corner radii and where they are used',
    render: () => <Radii />,
  },
  {
    id: 'tokens/spacing-and-radius/control-heights',
    title: 'Buttons, inputs and select triggers share four heights',
    render: () => <ControlHeights />,
  },
  {
    id: 'tokens/spacing-and-radius/hit-area',
    title: 'A hit area enlarges the pointer target without moving the layout',
    render: () => <HitArea />,
  },
]
