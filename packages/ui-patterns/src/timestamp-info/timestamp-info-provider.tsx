// Derived from supabase/supabase packages/ui-patterns/src/TimestampInfo/TimestampInfoProvider.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { createContext, type ReactNode, useContext, useMemo } from 'react'

interface TimestampInfoContextValue {
  /** IANA timezone applied to TimestampInfo when no `timezone` prop is set. */
  timezone?: string
}

const TimestampInfoContext = createContext<TimestampInfoContextValue>({})

export const TimestampInfoProvider = ({
  timezone,
  children,
}: {
  timezone?: string
  children: ReactNode
}) => {
  const value = useMemo(() => ({ timezone }), [timezone])
  return <TimestampInfoContext.Provider value={value}>{children}</TimestampInfoContext.Provider>
}

export const useTimestampInfoContext = () => useContext(TimestampInfoContext)
