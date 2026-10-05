import { currentCorrelation } from './context.ts'
import { describeError, type SafeErrorDescription } from './errors.ts'

/**
 * Optional error reporting ([self-observability.md §1](../../../exponetdb-docs/10-observability/self-observability.md#1-signals)).
 * A Sentry-compatible transport can implement {@link ErrorSink}; V1 ships
 * none. Whatever implements it receives only the safe projection of the
 * error (class, code, constant message) plus correlation ids, the same
 * redaction as logs. Reporting is best effort and never throws.
 */
export interface ErrorReport extends SafeErrorDescription {
  readonly event: string
  readonly requestId?: string
  readonly traceId?: string
}

export interface ErrorSink {
  capture(report: ErrorReport): void
}

export const noopErrorSink: ErrorSink = { capture: () => undefined }

export function reportError(sink: ErrorSink, event: string, error: unknown): void {
  try {
    const { requestId, traceId } = currentCorrelation()
    sink.capture({
      event,
      ...describeError(error),
      ...(requestId === undefined ? {} : { requestId }),
      ...(traceId === undefined ? {} : { traceId }),
    })
  } catch {
    // Telemetry never breaks correctness.
  }
}
