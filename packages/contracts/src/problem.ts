import {
  err,
  type Failure,
  failure,
  type OperationId,
  ok,
  type PlanId,
  type RequestId,
  type Result,
} from '@exponetdb/kernel'
import type * as z from 'zod'
import {
  ERRORS,
  type ErrorCode,
  type ErrorDefinition,
  errorTypeUri,
  type Problem,
  type ToolError,
  type ValidationIssueSchema,
} from './errors.ts'

export interface ProblemInput {
  readonly requestId: RequestId
  /** Must match the code's details schema; codes without one take no details. */
  readonly details?: unknown
  readonly operationId?: OperationId
  readonly planId?: PlanId
}

export type ProblemBuildFailure = Failure<'invalid_problem_details', { readonly code: ErrorCode }>

/**
 * Builds the wire form of an error. Title, status, message, retryability and
 * remediation come only from the catalog, so a caller cannot put exception
 * text, SQL, row values or secrets into them; the only variable parts are
 * schema-checked `details` and ids. Errors and their causes are never
 * serialized.
 */
export function buildProblem(
  code: ErrorCode,
  input: ProblemInput,
): Result<Problem, ProblemBuildFailure> {
  const def: ErrorDefinition = ERRORS[code]
  const details = checkDetails(code, def, input.details)
  if (!details.ok) {
    return details
  }
  return ok({
    type: errorTypeUri(code),
    title: def.title,
    status: def.status,
    ...body(code, def, details.value, input),
  })
}

/**
 * The MCP tool error for the same error (no HTTP fields). The MCP host renders it as
 * text in the tool result; it is not sent as `structuredContent` (error-model.md §2).
 */
export function buildToolError(
  code: ErrorCode,
  input: ProblemInput,
): Result<ToolError, ProblemBuildFailure> {
  const def: ErrorDefinition = ERRORS[code]
  const details = checkDetails(code, def, input.details)
  return details.ok ? ok(body(code, def, details.value, input)) : details
}

/**
 * The response for an unexpected failure: `INTERNAL` with the request id only.
 * Whatever went wrong stays in the server log, correlated by request id.
 */
export function internalProblem(requestId: RequestId): Problem {
  return {
    type: errorTypeUri('INTERNAL'),
    title: ERRORS.INTERNAL.title,
    status: ERRORS.INTERNAL.status,
    code: 'INTERNAL',
    message: ERRORS.INTERNAL.message,
    retryable: ERRORS.INTERNAL.retryable,
    requestId,
  }
}

/** `VALIDATION_FAILED` from boundary validation issues. */
export function validationProblem(
  requestId: RequestId,
  issues: readonly { readonly path: string; readonly code: string; readonly message: string }[],
): Result<Problem, ProblemBuildFailure> {
  return buildProblem('VALIDATION_FAILED', { requestId, details: { errors: issues.slice(0, 100) } })
}

function checkDetails(
  code: ErrorCode,
  def: ErrorDefinition,
  details: unknown,
): Result<Record<string, unknown> | undefined, ProblemBuildFailure> {
  const invalid = err(
    failure('invalid_problem_details', `Details do not match the schema of ${code}.`, { code }),
  )
  if (details === undefined) {
    // Details are required when the schema has one, unless that schema accepts their absence.
    return def.details === undefined || def.details.safeParse(undefined).success
      ? ok(undefined)
      : invalid
  }
  if (def.details === undefined) {
    return invalid
  }
  const parsed = def.details.safeParse(details)
  if (!parsed.success || !isRecord(parsed.data)) {
    return invalid
  }
  return ok(parsed.data)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function body(
  code: ErrorCode,
  def: ErrorDefinition,
  details: Record<string, unknown> | undefined,
  input: ProblemInput,
): ToolError {
  return {
    code,
    message: def.message,
    retryable: def.retryable,
    ...(details === undefined ? {} : { details }),
    ...(def.remediation === undefined ? {} : { remediation: def.remediation }),
    requestId: input.requestId,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.planId === undefined ? {} : { planId: input.planId }),
  }
}

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>
