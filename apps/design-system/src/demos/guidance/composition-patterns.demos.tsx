import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@exponetdb/ui'
import {
  type LinkComponentProps,
  LinkProvider,
  linkableHref,
  NavigateProvider,
  type OnTelemetry,
  TelemetryProvider,
  useLinkComponent,
  useNavigate,
  useTelemetry,
} from '@exponetdb/ui-patterns'
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'
import type { DemoDefinition } from '../types.ts'

// ---------------------------------------------------------------------------
// Parts instead of flags: the same card, with and without actions
// ---------------------------------------------------------------------------

function Parts(): ReactNode {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Plan summary</CardTitle>
          <CardDescription>Applies 2 migrations to shop/platform/staging.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="m-0 text-sm text-foreground-light">Class standard. Expires at 12:15 UTC.</p>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button variant="default">Withdraw plan</Button>
          <Button variant="primary">Apply to staging</Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Plan summary</CardTitle>
          <CardDescription>Applies 2 migrations to shop/platform/production.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="m-0 text-sm text-foreground-light">
            Waiting for approval. Only a person can approve it.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The seams: the pattern asks, the app answers
// ---------------------------------------------------------------------------

/** What the app received from the patterns, newest last. */
const Recorder = createContext<(entry: string) => void>(() => {})

/** The app's link: here it records the request instead of changing the page. */
function RecordingLink({ href, onClick, ref, ...props }: LinkComponentProps): ReactNode {
  const record = useContext(Recorder)
  return (
    <a
      ref={ref}
      href={linkableHref(href)}
      {...props}
      onClick={(event) => {
        onClick?.(event)
        event.preventDefault()
        record(`Link: the app opened ${href}`)
      }}
    />
  )
}

/** A pattern-side component: it renders a link, asks to navigate and reports an event, nothing else. */
function Pattern(): ReactNode {
  const Link = useLinkComponent()
  const navigate = useNavigate()
  const telemetry = useTelemetry()
  return (
    <div className="flex flex-col items-start gap-3">
      <Link href="/changes/plans/pln_01K9D4" className="text-sm text-foreground underline">
        Open plan pln_01K9D4
      </Link>
      <div className="flex flex-wrap gap-2">
        <Button variant="default" onClick={() => navigate('/changes/plans')}>
          Go to plans
        </Button>
        <Button
          variant="default"
          onClick={() => telemetry({ name: 'plan.review.opened', properties: { tier: 'prod' } })}
        >
          Report an event
        </Button>
      </div>
    </div>
  )
}

function Seams(): ReactNode {
  const [entries, setEntries] = useState<readonly string[]>([])
  const record = useCallback((entry: string) => setEntries((previous) => [...previous, entry]), [])
  const onTelemetry: OnTelemetry = useCallback(
    (event) => record(`Telemetry: ${event.name} ${JSON.stringify(event.properties ?? {})}`),
    [record],
  )
  return (
    <Recorder.Provider value={record}>
      <LinkProvider component={RecordingLink}>
        <NavigateProvider navigate={(path) => record(`Navigate: the app went to ${path}`)}>
          <TelemetryProvider onTelemetry={onTelemetry}>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <Pattern />
              <div className="flex flex-col gap-1">
                <p className="m-0 text-xs font-medium text-foreground-lighter">
                  What the app received
                </p>
                <ol aria-label="What the app received" className="m-0 min-h-16 pl-5 text-sm">
                  {entries.map((entry, index) => (
                    // The log only grows; the position is its identity.
                    // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
                    <li key={index} className="font-mono text-xs text-foreground-light">
                      {entry}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </TelemetryProvider>
        </NavigateProvider>
      </LinkProvider>
    </Recorder.Provider>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/composition-patterns/parts',
    title: 'The same card from the same parts, with and without actions',
    render: () => <Parts />,
  },
  {
    id: 'guidance/composition-patterns/seams',
    title: 'A pattern asks for a link, a navigation and an event; the app decides what happens',
    render: () => <Seams />,
  },
]
