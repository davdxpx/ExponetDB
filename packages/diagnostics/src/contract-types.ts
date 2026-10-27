import type {
  AdvisorRunSchema,
  ConnectionCancelRequestSchema,
  ConnectionTerminateRequestSchema,
  FindingSummarySchema,
  QueryStatsSchema,
  TableStatsSchema,
} from '@exponetdb/contracts'

/**
 * The Wave 9 Part B response shapes, as the contracts' schemas output them
 * (the contracts export the schemas; these are their parsed types).
 */
export type QueryStats = ReturnType<typeof QueryStatsSchema.parse>
export type TableStats = ReturnType<typeof TableStatsSchema.parse>
export type AdvisorRun = ReturnType<typeof AdvisorRunSchema.parse>
export type FindingSummary = ReturnType<typeof FindingSummarySchema.parse>
export type ConnectionCancelRequest = ReturnType<typeof ConnectionCancelRequestSchema.parse>
export type ConnectionTerminateRequest = ReturnType<typeof ConnectionTerminateRequestSchema.parse>
