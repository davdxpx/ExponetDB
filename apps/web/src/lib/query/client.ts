import { QueryClient } from '@tanstack/react-query'
import { isRetryable } from './errors.ts'

/**
 * The page's query cache: in memory only (never persisted), reads retried
 * only when the server could not be reached or was unavailable (at most
 * twice, with backoff), never a mutation; refreshed on focus and
 * reconnection; polling screens set their own interval, paused while the
 * tab is hidden. Cleared on sign-out and when the session is gone.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failures, error) => failures < 2 && isRetryable(error),
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        refetchIntervalInBackground: false,
      },
      mutations: { retry: false },
    },
  })
}
