import { Badge, Button, Switch } from '@exponetdb/ui'
import type { CSSProperties, ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

/** A small card painted only by tokens, so each theme scope shows its own derivation. */
function Sample({ title }: { readonly title: string }): ReactNode {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-default bg-background p-4 text-foreground">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <Badge variant="success">Verified</Badge>
      </div>
      <p className="text-sm text-foreground-light">
        Surfaces, text, borders and the spot color all derive from the inputs of this scope.
      </p>
      <div className="flex items-center gap-2">
        <Switch defaultChecked aria-label={`${title}: notify on failure`} />
        <span className="text-xs text-foreground-lighter">Notify on failure</span>
      </div>
      <div className="flex gap-2">
        <Button variant="primary">Create plan</Button>
        <Button variant="default">Cancel</Button>
      </div>
    </div>
  )
}

function Scopes(): ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div data-theme="light" className="rounded-lg">
        <Sample title="data-theme light" />
      </div>
      <div data-theme="dark" className="rounded-lg">
        <Sample title="data-theme dark" />
      </div>
    </div>
  )
}

// The spot color is two inputs on the scope: `--hue` and `--surface-hue`. Custom properties are
// valid style keys that CSSProperties does not list.
function hueStyle(hue: number): CSSProperties {
  return { '--hue': hue, '--surface-hue': hue } as CSSProperties
}

function SpotColors(): ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div data-theme="light" style={hueStyle(178)} className="rounded-lg">
        <Sample title="--hue: 178 (the turquoise accent)" />
      </div>
      <div data-theme="light" style={hueStyle(300)} className="rounded-lg">
        <Sample title="--hue: 300 (an example)" />
      </div>
    </div>
  )
}

const FIXED_HUES = [
  { cls: 'bg-destructive text-destructive-foreground', name: 'destructive', hue: '25' },
  { cls: 'bg-warning text-warning-foreground', name: 'warning', hue: '70' },
  { cls: 'bg-success text-success-foreground', name: 'success', hue: '150' },
  { cls: 'bg-info text-info-foreground', name: 'info', hue: '205' },
  { cls: 'bg-production text-production-foreground', name: 'production', hue: '262' },
] as const

function FixedHues(): ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {([178, 300] as const).map((hue) => (
        <div
          key={hue}
          data-theme="light"
          style={hueStyle(hue)}
          className="flex flex-col gap-2 rounded-lg border border-default bg-background p-4"
        >
          <p className="font-mono text-xs text-foreground-light">--hue: {hue}</p>
          <ul aria-label={`Expressive colors at hue ${hue}`} className="flex flex-wrap gap-2">
            {FIXED_HUES.map((fixed) => (
              <li
                key={fixed.name}
                className={`rounded-md px-2 py-1 text-xs font-medium ${fixed.cls}`}
              >
                {fixed.name} ({fixed.hue})
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'tokens/theme/scopes',
    title: 'A light and a dark scope side by side',
    render: () => <Scopes />,
  },
  {
    id: 'tokens/theme/spot-color',
    title: 'The spot color is an input: two hues, nothing else changed',
    render: () => <SpotColors />,
  },
  {
    id: 'tokens/theme/fixed-hues',
    title: 'The expressive hues stay put when the spot color changes',
    render: () => <FixedHues />,
  },
]
