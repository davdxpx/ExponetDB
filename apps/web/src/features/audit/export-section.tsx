import { Button, Input } from '@exponetdb/ui'
import { Admonition } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { Field } from '../access/fields.tsx'
import { exportFileName, exportHeader, saveFile } from './download.ts'
import { isAuditTime } from './search.ts'

/**
 * The audit export (owner decision S7, audit.md §5.1): the stored events
 * verbatim as NDJSON for offline verification, for owners and admins
 * (`policy.manage`), from a Web App session re-authenticated within 300
 * seconds. The request goes through the page's API client (session cookie,
 * never an `Authorization` header); a stale proof answers `REAUTH_REQUIRED`,
 * the identity dialog opens, and only a confirmed proof sends it again. The
 * file holds full events with personal data (OD-8), which the section says
 * before anything is downloaded. A part holds at most 10,000 events; the next
 * part continues with the server's cursor and the same range.
 */
const BOUND = /^(?:\d{1,19})$/

function boundProblem(value: string): boolean {
  const trimmed = value.trim()
  return trimmed !== '' && !BOUND.test(trimmed) && !isAuditTime(trimmed)
}

interface Part {
  readonly firstSeq: number | null
  readonly lastSeq: number | null
  readonly count: number
  readonly nextCursor: string | null
  readonly from: string
  readonly to: string
}

export function ExportSection(): ReactNode {
  const { client, confirmIdentity } = useApi()
  const id = useId()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [errors, setErrors] = useState<{ from?: string; to?: string }>({})
  const [busy, setBusy] = useState(false)
  const [part, setPart] = useState<Part | null>(null)
  const [status, setStatus] = useState({ text: '', alert: '' })
  const inFlight = useRef(false)

  const download = async (range: { from: string; to: string }, cursor?: string): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setStatus({ text: '', alert: '' })
    try {
      const query = {
        ...(range.from === '' ? {} : { from: range.from }),
        ...(range.to === '' ? {} : { to: range.to }),
        ...(cursor === undefined ? {} : { cursor }),
      }
      const text = await withReauth(client, confirmIdentity, () =>
        client.operationText('exportAuditEvents', { query }),
      )
      const header = exportHeader(text)
      if (header === undefined) {
        setStatus({ text: '', alert: t('audit.export.unreadable') })
        return
      }
      saveFile(text, exportFileName(header))
      setPart({ ...header, nextCursor: header.more ? header.nextCursor : null, ...range })
      setStatus({
        text:
          header.firstSeq === null || header.lastSeq === null
            ? t('audit.export.done.empty')
            : t('audit.export.done', {
                count: header.count,
                first: header.firstSeq,
                last: header.lastSeq,
              }),
        alert: '',
      })
    } catch (error) {
      setStatus({ text: '', alert: describeError(error) })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const next = {
      ...(boundProblem(from) ? { from: t('audit.export.bound.invalid') } : {}),
      ...(boundProblem(to) ? { to: t('audit.export.bound.invalid') } : {}),
    }
    setErrors(next)
    if (next.from !== undefined || next.to !== undefined) return
    setPart(null)
    void download({ from: from.trim(), to: to.trim() })
  }

  return (
    <section id="audit-export" aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="text-base font-medium text-foreground">
        {t('audit.export.title')}
      </h2>
      <Admonition
        type="warning"
        title={t('audit.export.personal.title')}
        description={t('audit.export.personal.body')}
      />
      <div className="flex flex-col gap-1 text-sm text-foreground-light">
        <p>{t('audit.export.verify.intro')}</p>
        <ol className="list-decimal pl-5">
          <li>{t('audit.export.verify.step1')}</li>
          <li>{t('audit.export.verify.step2')}</li>
          <li>{t('audit.export.verify.step3')}</li>
          <li>{t('audit.export.verify.step4')}</li>
        </ol>
        <p>{t('audit.export.verify.doc')}</p>
      </div>
      <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            id={`${id}-from`}
            label={t('audit.export.from')}
            description={t('audit.export.bound.hint')}
            error={errors.from}
          >
            <Input
              id={`${id}-from`}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={from}
              aria-invalid={errors.from !== undefined}
              aria-describedby={`${id}-from-description`}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field
            id={`${id}-to`}
            label={t('audit.export.to')}
            description={t('audit.export.bound.hintTo')}
            error={errors.to}
          >
            <Input
              id={`${id}-to`}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={to}
              aria-invalid={errors.to !== undefined}
              aria-describedby={`${id}-to-description`}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="default" size="small" loading={busy}>
            {t('audit.export.submit')}
          </Button>
          {part === null || part.nextCursor === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="small"
              disabled={busy}
              onClick={() =>
                void download({ from: part.from, to: part.to }, part.nextCursor ?? undefined)
              }
            >
              {t('audit.export.next')}
            </Button>
          )}
        </div>
      </form>
      <div className="flex flex-col gap-1">
        <p className="export-status text-sm text-foreground" role="status" aria-live="polite">
          {status.text}
        </p>
        <p className="export-alert text-sm text-destructive" role="alert">
          {status.alert}
        </p>
      </div>
    </section>
  )
}
