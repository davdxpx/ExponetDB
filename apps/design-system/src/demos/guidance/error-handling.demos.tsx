import { Button, Label, RadioGroup, RadioGroupItem } from '@exponetdb/ui'
import { ConfirmDialog, ErrorDisplay } from '@exponetdb/ui-patterns'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { wait } from './support.tsx'

// ---------------------------------------------------------------------------
// One function decides what a person reads for a failure
// ---------------------------------------------------------------------------

/** What the server sends: a stable code, catalog text and, for a rate limit, the wait. */
class CatalogError extends Error {
  readonly code: string
  readonly retryAfterSeconds: number | undefined

  constructor(code: string, message: string, retryAfterSeconds?: number) {
    super(message)
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

interface Described {
  readonly message: string
  readonly code: string
}

/**
 * The text of a failure: the catalog message with its stable code, fixed text for the failures
 * the browser makes up (network, unknown) and the wait for a rate limit. The message of any other
 * exception is never shown: it can hold a statement, a host name or a credential.
 */
function describe(error: unknown): Described {
  if (error instanceof CatalogError) {
    if (error.code === 'NETWORK') {
      return {
        code: 'NETWORK',
        message: 'The server could not be reached. Check your connection and try again.',
      }
    }
    if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== undefined) {
      return {
        code: 'RATE_LIMITED',
        message: `Too many attempts. Try again in ${Math.ceil(error.retryAfterSeconds)} seconds.`,
      }
    }
    return { code: error.code, message: error.message }
  }
  return { code: 'UNKNOWN', message: 'Something went wrong. Reload the page and try again.' }
}

const CASES = [
  {
    id: 'catalog',
    label: 'A catalog error',
    thrown: () =>
      new CatalogError('PLAN_STALE', 'The plan no longer matches the target. Create a new plan.'),
  },
  {
    id: 'network',
    label: 'The server could not be reached',
    thrown: () => new CatalogError('NETWORK', 'fetch failed'),
  },
  {
    id: 'rate-limited',
    label: 'Too many requests, with a wait of 30 seconds',
    thrown: () => new CatalogError('RATE_LIMITED', 'Rate limit exceeded', 29.2),
  },
  {
    id: 'unknown',
    label: 'An exception the page did not expect',
    thrown: () => new Error('password authentication failed for user "migrator"'),
  },
] as const

type CaseId = (typeof CASES)[number]['id']

function ErrorClasses(): ReactNode {
  const groupId = useId()
  const [selected, setSelected] = useState<CaseId>('catalog')
  const entry = CASES.find((candidate) => candidate.id === selected) ?? CASES[0]
  const error = entry.thrown()
  const shown = describe(error)

  return (
    <div className="flex flex-col gap-4">
      <RadioGroup
        aria-label="Which failure"
        value={selected}
        onValueChange={(value) => {
          const next = CASES.find((candidate) => candidate.id === value)
          if (next !== undefined) setSelected(next.id)
        }}
      >
        {CASES.map((candidate) => {
          const id = `${groupId}-${candidate.id}`
          return (
            <div key={candidate.id} className="flex items-center gap-2">
              <RadioGroupItem id={id} value={candidate.id} />
              <Label htmlFor={id} className="text-foreground">
                {candidate.label}
              </Label>
            </div>
          )
        })}
      </RadioGroup>
      <p className="m-0 text-xs text-foreground-lighter">
        What the code received: <span className="font-mono">{error.message}</span>
      </p>
      <ErrorDisplay
        title="Could not apply the plan"
        message={shown.message}
        code={shown.code}
        headingLevel={3}
        actions={
          <Button variant="default" size="tiny">
            Try again
          </Button>
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// A failed action keeps the dialog open and shows the same kind of text
// ---------------------------------------------------------------------------

function DialogFailures(): ReactNode {
  return (
    <div className="flex flex-wrap gap-2">
      <ConfirmDialog
        trigger={<Button variant="default">Apply, plan is stale</Button>}
        title="Apply to staging?"
        description="Applies 2 migrations to shop/platform/staging."
        actionLabel="Apply to staging"
        onConfirm={async () => {
          await wait(200)
          throw new CatalogError(
            'PLAN_STALE',
            'The plan no longer matches the target. Create a new plan.',
          )
        }}
      />
      <ConfirmDialog
        trigger={<Button variant="default">Apply, unexpected error</Button>}
        title="Apply to staging?"
        description="Applies 2 migrations to shop/platform/staging."
        actionLabel="Apply to staging"
        onConfirm={async () => {
          await wait(200)
          throw new Error('relation "orders" does not exist (SQLSTATE 42P01)')
        }}
      />
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/error-handling/classes',
    title: 'Catalog text with its code, fixed text for the rest, the exception never shown',
    render: () => <ErrorClasses />,
  },
  {
    id: 'guidance/error-handling/dialog-failure',
    title: 'A failed action keeps its dialog open and shows the failure under the same rules',
    visual: false,
    render: () => <DialogFailures />,
  },
]
