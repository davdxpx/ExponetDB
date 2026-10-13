import { createContext, type ReactNode, useContext } from 'react'

/**
 * Optional interaction events of patterns (a command menu opened, a filter
 * applied). The default does nothing; ExponetDB ships no telemetry client and
 * the Web App names no telemetry endpoint (C-20). An event carries a fixed
 * name and fixed properties, never user content.
 */
export interface TelemetryEvent {
  readonly name: string
  readonly properties?: Readonly<Record<string, string | number | boolean>>
}

export type OnTelemetry = (event: TelemetryEvent) => void

const noTelemetry: OnTelemetry = () => {}

const TelemetryContext = createContext<OnTelemetry>(noTelemetry)

export function TelemetryProvider({
  onTelemetry,
  children,
}: {
  onTelemetry: OnTelemetry
  children: ReactNode
}): ReactNode {
  return <TelemetryContext.Provider value={onTelemetry}>{children}</TelemetryContext.Provider>
}

export function useTelemetry(): OnTelemetry {
  return useContext(TelemetryContext)
}
