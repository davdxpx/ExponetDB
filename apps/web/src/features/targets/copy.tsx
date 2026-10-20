import { Copy } from '@exponetdb/icons'
import { Button, copyToClipboard, toast } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * Copies text to the clipboard and tells the person whether it worked
 * (`copyToClipboard` never rejects and shows nothing itself). Used for paths,
 * ids and the read-only text of the registry pages; none of it is a secret.
 */
export async function copyText(what: string, text: string): Promise<void> {
  if (await copyToClipboard(text)) {
    toast.success(t('connect.copy.done', { what }))
  } else {
    toast.error(t('connect.copy.failed'), {
      description: t('connect.copy.failedDetail', { what }),
    })
  }
}

/** A small "Copy" button; its accessible name says what it copies ("Copy target path"). */
export function CopyButton(props: {
  /** What is copied, starting a sentence ("Target path"): the toast says "Target path copied". */
  readonly what: string
  /** The accessible name of the button ("Copy target path"). */
  readonly label: string
  readonly text: string
  readonly className?: string
}): ReactNode {
  return (
    <Button
      type="button"
      variant="text"
      size="tiny"
      icon={<Copy aria-hidden="true" />}
      aria-label={props.label}
      {...(props.className === undefined ? {} : { className: props.className })}
      onClick={() => void copyText(props.what, props.text)}
    >
      {t('connect.copy')}
    </Button>
  )
}
