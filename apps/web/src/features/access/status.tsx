import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { ApiError, CLIENT_CODES } from '../../lib/api/errors.ts'
import { describeError } from '../../lib/i18n/i18n.ts'

/**
 * The outcome line of an administration page, as the Wave 3B pages had it:
 * one polite status line (`p.status`) for what was done and one alert line
 * (`p.alert`) for what failed. Each message replaces the other; both are
 * text only. Errors are described by `describeError` (the server's catalog
 * message with its code, fixed text otherwise), never by exception text.
 */
export interface StatusLine {
  readonly status: string
  readonly alert: string
  readonly say: (text: string) => void
  readonly fail: (error: unknown) => void
  readonly clear: () => void
}

export function useStatusLine(): StatusLine {
  const [line, setLine] = useState({ status: '', alert: '' })
  const say = useCallback((text: string) => setLine({ status: text, alert: '' }), [])
  const fail = useCallback(
    (error: unknown) => setLine({ status: '', alert: describeError(error) }),
    [],
  )
  const clear = useCallback(() => setLine({ status: '', alert: '' }), [])
  return useMemo(
    () => ({ status: line.status, alert: line.alert, say, fail, clear }),
    [line, say, fail, clear],
  )
}

export function StatusLines({ line }: { readonly line: StatusLine }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <p className="status text-sm text-foreground" role="status" aria-live="polite">
        {line.status}
      </p>
      <p className="alert text-sm text-destructive" role="alert">
        {line.alert}
      </p>
    </div>
  )
}

/**
 * A failed action as the confirmation dialogs show it (`ActionFailure`):
 * the stable code and the text `describeError` gives, without the code it
 * appends (the dialog shows the code on its own line).
 */
export class ActionFailed extends Error {
  override readonly name = 'ActionFailed'
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function actionFailed(error: unknown): ActionFailed {
  const code = error instanceof ApiError ? error.code : CLIENT_CODES.UNKNOWN
  const text = describeError(error)
  const suffix = ` (${code})`
  return new ActionFailed(code, text.endsWith(suffix) ? text.slice(0, -suffix.length) : text)
}
