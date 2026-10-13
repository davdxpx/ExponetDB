import { cn } from '@exponetdb/ui'

/** The design-system app's shell. Phase 1 seed; Phase 6 adds guidance, demos and the index. */
export function App() {
  return (
    <main className={cn('mx-auto max-w-3xl p-6')}>
      <h1 className="text-2xl font-semibold">ExponetDB design system</h1>
      <p>Guidance, components and patterns of the ExponetDB Web App.</p>
    </main>
  )
}
