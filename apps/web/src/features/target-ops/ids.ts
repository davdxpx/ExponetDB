import { isOperationId } from '../plans/plan-model.ts'

/**
 * What a target page trusts in an id it received (C-26): the grammar of the
 * contract, nothing looser. An id that fails is shown as marked text and is
 * never put in a link or a request.
 */
const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'
const FINDING_ID = new RegExp(`^fnd_${ULID}$`)
const REPORT_ID = new RegExp(`^imr_${ULID}$`)
const PROJECT_ID = new RegExp(`^prj_${ULID}$`)
const TARGET_ID = new RegExp(`^tgt_${ULID}$`)
const CLUSTER_ID = new RegExp(`^cls_${ULID}$`)
const ITEM_ID = /^[0-9]{1,6}$/

export const isFindingId = (value: unknown): value is string =>
  typeof value === 'string' && FINDING_ID.test(value)
export const isReportId = (value: unknown): value is string =>
  typeof value === 'string' && REPORT_ID.test(value)
export const isProjectId = (value: unknown): value is string =>
  typeof value === 'string' && PROJECT_ID.test(value)
export const isTargetId = (value: unknown): value is string =>
  typeof value === 'string' && TARGET_ID.test(value)
export const isClusterId = (value: unknown): value is string =>
  typeof value === 'string' && CLUSTER_ID.test(value)
export const isItemId = (value: unknown): value is string =>
  typeof value === 'string' && ITEM_ID.test(value)

/** The page of an operation, or `undefined` for anything that is not an operation id. */
export function operationPath(operationId: unknown): string | undefined {
  return isOperationId(operationId) ? `/changes/operations/${operationId}` : undefined
}

/** The page of a cluster, or `undefined` for anything that is not a cluster id. */
export function clusterPath(clusterId: unknown): string | undefined {
  return isClusterId(clusterId) ? `/infrastructure/clusters/${clusterId}` : undefined
}
