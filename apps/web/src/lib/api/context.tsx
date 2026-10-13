import { createContext, type ReactNode, useContext } from 'react'
import type { ApiClient } from './client.ts'
import type { ConfirmIdentity } from './reauth.ts'

/**
 * The page's one API client and the re-authentication dialog it opens, for
 * every component below the provider. Components never call `fetch`.
 */
export interface ApiContextValue {
  readonly client: ApiClient
  readonly confirmIdentity: ConfirmIdentity
}

const ApiContext = createContext<ApiContextValue | undefined>(undefined)

export function ApiProvider(props: {
  readonly value: ApiContextValue
  readonly children: ReactNode
}) {
  return <ApiContext.Provider value={props.value}>{props.children}</ApiContext.Provider>
}

export function useApi(): ApiContextValue {
  const value = useContext(ApiContext)
  if (value === undefined) {
    throw new Error('useApi() outside <ApiProvider>')
  }
  return value
}
