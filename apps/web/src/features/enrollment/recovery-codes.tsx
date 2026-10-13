import { Button, Checkbox, copyToClipboard, Label, toast } from '@exponetdb/ui'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * Recovery codes, shown exactly once (identity.md §9): the server returns
 * them in the answer that created them and stores only hashes. They live in
 * the state of the page that received them until the person confirms they
 * stored them (`#codes-stored` gates `#continue`); then the page drops them
 * and nothing can show them again. They are never written to storage, the
 * query cache or a log. The heading takes the focus when the codes appear.
 */
export function RecoveryCodesPanel({
  codes,
  onContinue,
}: {
  readonly codes: readonly string[]
  readonly onContinue: () => void
}): ReactNode {
  const [stored, setStored] = useState(false)
  const headingId = useId()
  const storedId = 'codes-stored'
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  const copy = async (): Promise<void> => {
    if (await copyToClipboard(codes.join('\n'))) {
      toast.success(t('enrollment.codes.copied'))
    } else {
      toast.error(t('enrollment.codes.copyFailed'))
    }
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="text-lg font-medium text-foreground outline-none"
      >
        {t('enrollment.codes.title')}
      </h2>
      <p className="text-sm text-foreground-light">{t('enrollment.codes.intro')}</p>
      <ol
        id="recovery-codes"
        aria-label={t('enrollment.codes.list')}
        className="codes grid grid-cols-1 gap-2 rounded-lg border border-default bg-surface-100 p-4 sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code} className="font-mono text-sm">
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <div>
        <Button type="button" variant="default" size="small" onClick={() => void copy()}>
          {t('enrollment.codes.copy')}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={storedId}
          checked={stored}
          onCheckedChange={(value) => setStored(value === true)}
        />
        <Label htmlFor={storedId}>{t('enrollment.codes.stored')}</Label>
      </div>
      <div>
        <Button
          id="continue"
          type="button"
          variant="primary"
          size="medium"
          disabled={!stored}
          onClick={onContinue}
        >
          {t('enrollment.codes.continue')}
        </Button>
      </div>
    </section>
  )
}
