import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@exponetdb/ui'
import { ObservedTime, UntrustedText } from '@exponetdb/ui-patterns'
import { type ReactNode, useRef, useState } from 'react'
import type { ResponseOf } from '../../lib/api/client.ts'
import { useApi } from '../../lib/api/context.tsx'
import { ApiError } from '../../lib/api/errors.ts'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { type NotAvailableReason, notAvailableReason } from './model.ts'

/**
 * The raw statement view (owner decision S2, resources.md "Sessions, locks,
 * performance"): the text of one statement, read **live** from the target when
 * the person asks, checked against its digest by the server, with secrets
 * still removed. A person in the Web App only, re-authenticated within 15
 * minutes (`withReauth`); the server decides, the page shows its answer.
 *
 * Nothing about the text outlives the view: it lives in this component's state
 * only (never the query cache, the URL, local or session storage, a title or a
 * log), and closing the dialog unmounts it, which discards the text. A
 * statement the target does not hold now is `STATEMENT_NOT_AVAILABLE` with the
 * reason the server names; each reason is shown as what it is, never as text
 * that was stored or invented.
 */
type RawStatement = ResponseOf<'getRawStatement'>

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'shown'; readonly statement: RawStatement }
  | {
      readonly kind: 'unavailable'
      readonly reason: NotAvailableReason | undefined
      readonly code: string
    }
  | { readonly kind: 'failed'; readonly message: string }

const REASON_KEYS: Readonly<Record<NotAvailableReason, MessageKey>> = {
  not_held: 'raw.unavailable.not_held',
  target_unreachable: 'raw.unavailable.target_unreachable',
  digest_mismatch: 'raw.unavailable.digest_mismatch',
  extension_missing: 'raw.unavailable.extension_missing',
}

const MODE_KEYS: Readonly<Record<RawStatement['redaction']['mode'], MessageKey>> = {
  literal: 'raw.mode.literal',
  summary: 'raw.mode.summary',
  unparseable: 'raw.mode.unparseable',
}

export function RawStatementButton(props: {
  readonly targetPath: string
  readonly digest: string
  readonly pid: number
  readonly backendStart: string
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const [view, setView] = useState<View | undefined>(undefined)
  const controller = useRef<AbortController | undefined>(undefined)

  const open = (): void => {
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setView({ kind: 'loading' })
    // The digest, the target and the session's identity only; never any text.
    withReauth(client, confirmIdentity, () =>
      client.operation('getRawStatement', {
        params: { digest: props.digest },
        query: { target: props.targetPath, pid: props.pid, backendStart: props.backendStart },
        signal: abort.signal,
      }),
    ).then(
      (statement) => {
        if (!abort.signal.aborted) setView({ kind: 'shown', statement })
      },
      (error: unknown) => {
        if (abort.signal.aborted) return
        if (error instanceof ApiError && error.code === 'STATEMENT_NOT_AVAILABLE') {
          setView({
            kind: 'unavailable',
            reason: notAvailableReason(error.details),
            code: error.code,
          })
          return
        }
        setView({ kind: 'failed', message: describeError(error) })
      },
    )
  }

  const close = (): void => {
    controller.current?.abort()
    controller.current = undefined
    // The text is dropped with the state; nothing else ever held it.
    setView(undefined)
  }

  return (
    <>
      <Button type="button" variant="link" size="tiny" onClick={open}>
        {t('raw.open')}
      </Button>
      {view === undefined ? null : (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) close()
          }}
        >
          <DialogContent size="large" hideClose data-raw-statement="">
            <DialogHeader>
              <DialogTitle>{t('raw.title')}</DialogTitle>
              <DialogDescription>{t('raw.description')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 px-5 pb-5" aria-busy={view.kind === 'loading'}>
              <RawBody view={view} />
              <div>
                <Button type="button" variant="default" size="small" onClick={close}>
                  {t('raw.close')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

function RawBody({ view }: { readonly view: View }): ReactNode {
  switch (view.kind) {
    case 'loading':
      return (
        <p role="status" className="text-sm text-foreground-light">
          {t('raw.loading')}
        </p>
      )
    case 'unavailable':
      return (
        <div
          role="alert"
          data-state="statement-not-available"
          className="flex flex-col gap-1 text-sm"
        >
          <p className="font-medium text-foreground">{t('raw.unavailable.title')}</p>
          <p>
            {view.reason === undefined
              ? t('raw.unavailable.unknown', { reason: view.code })
              : t(REASON_KEYS[view.reason])}
          </p>
          <p className="text-foreground-light">{t('raw.unavailable.footer')}</p>
        </div>
      )
    case 'failed':
      return (
        <p role="alert" className="text-sm text-destructive">
          {t('raw.failed', { reason: view.message })}
        </p>
      )
    case 'shown': {
      const { statement } = view
      return (
        <div className="flex flex-col gap-2" data-state="raw-statement">
          <p className="text-xs text-foreground-light">
            {t('raw.note', {
              mode: nounPhrase(MODE_KEYS[statement.redaction.mode]),
              removed: statement.redaction.removed,
            })}{' '}
            <ObservedTime observedAt={statement.observedAt} seconds />
          </p>
          <p className="text-xs text-foreground-light">
            {statement.origin.view === 'pg_stat_activity'
              ? t('raw.origin.session', { pid: statement.origin.pid })
              : t('raw.origin.statistics', { calls: statement.origin.calls })}
          </p>
          <UntrustedText text={statement.text} mono label={t('raw.label')} maxLines={20} />
          {statement.truncated ? (
            <p className="text-xs text-foreground-light">{t('raw.truncated')}</p>
          ) : null}
        </div>
      )
    }
  }
}
