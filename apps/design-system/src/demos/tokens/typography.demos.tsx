import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

const SCALE = [
  { cls: 'text-xs', size: '12 px', use: 'Dense chrome: tiny controls, table heads, helper text' },
  { cls: 'text-sm', size: '14 px', use: 'Body text of the Web App and most controls' },
  { cls: 'text-base', size: '16 px', use: 'Dialog titles, inputs on small screens' },
  { cls: 'text-lg', size: '18 px', use: 'Sheet titles, section headings' },
  { cls: 'text-xl', size: '20 px', use: 'Page section headings' },
  { cls: 'text-2xl', size: '24 px', use: 'Page titles' },
  { cls: 'text-3xl', size: '30 px', use: 'Titles of full-page states' },
] as const

function Scale(): ReactNode {
  return (
    <ul aria-label="Type scale" className="flex flex-col gap-3">
      {SCALE.map((step) => (
        <li key={step.cls} className="flex flex-col gap-0.5">
          <p className={`${step.cls} text-foreground`}>Plan awaiting approval</p>
          <p className="font-mono text-xs text-foreground-light">
            {step.cls} ({step.size}): {step.use}
          </p>
        </li>
      ))}
    </ul>
  )
}

function Families(): ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1 rounded-md border border-default p-4">
        <p className="font-mono text-xs text-foreground-light">font-sans: Inter</p>
        <p className="font-sans text-sm font-normal text-foreground">Regular 400: body text</p>
        <p className="font-sans text-sm font-medium text-foreground">Medium 500: labels, titles</p>
        <p className="font-sans text-sm font-semibold text-foreground">
          Semibold 600: strong emphasis
        </p>
      </div>
      <div className="flex flex-col gap-1 rounded-md border border-default p-4">
        <p className="font-mono text-xs text-foreground-light">font-mono: Source Code Pro</p>
        <p className="font-mono text-sm font-normal text-foreground">
          Regular 400: shop/platform/staging
        </p>
        <p className="font-mono text-sm font-medium text-foreground">
          Medium 500: 01JA8Q3M5T7V9XBZC4D6E8F0GH_add_orders_index
        </p>
        <p className="font-mono text-sm text-foreground">0123456789 il1 O0 sha256:c1:9f2e…</p>
      </div>
    </div>
  )
}

function Roles(): ReactNode {
  return (
    <div className="flex max-w-xl flex-col gap-4 rounded-md border border-default bg-card p-4">
      <div>
        <p className="font-mono text-xs tracking-wider text-foreground-lighter uppercase">
          Migrations
        </p>
        <h3 className="text-xl tracking-tight text-foreground">Add index on orders.customer_id</h3>
        <p className="mt-1 text-sm text-foreground-light">
          Creates the index without blocking writes. It runs on{' '}
          <code className="text-code-inline">shop/platform/staging</code> first.
        </p>
      </div>
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-foreground-light">Plan hash</dt>
        <dd className="truncate font-mono text-xs text-foreground">sha256:4b8c0e2f7a1d93c5…</dd>
        <dt className="text-foreground-light">Class</dt>
        <dd className="text-foreground">Standard</dd>
        <dt className="text-foreground-light">Expires</dt>
        <dd className="text-foreground">in 12 minutes</dd>
      </dl>
      <p className="text-xs text-foreground-lighter">Observed 4 minutes ago, live.</p>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'tokens/typography/scale',
    title: 'The type scale in use',
    render: () => <Scale />,
  },
  {
    id: 'tokens/typography/families',
    title: 'The two families and their weights',
    render: () => <Families />,
  },
  {
    id: 'tokens/typography/roles',
    title: 'Roles on one panel: eyebrow, title, body, values, hint',
    render: () => <Roles />,
  },
]
