import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useRef, useState } from 'react'
import { describeError, t } from '../../lib/i18n/i18n.ts'

/**
 * A dialog with a form whose submit asks the server for something (a plan,
 * an attestation): it runs once while pending, keeps the dialog open with the
 * failure (catalog text and code, never an exception), and closes when the
 * request succeeded. `validate` names the first problem of the input, which
 * blocks the submit and is said next to the button. Nothing here applies a
 * change: a plan opens its review page, where a person applies it.
 */
export function FormDialog(props: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: string
  readonly description: ReactNode
  readonly submitLabel: string
  readonly destructive?: boolean
  /** The first problem of the input, or `undefined` when it can be sent. */
  readonly problem?: string | undefined
  /** Sends the request; the dialog closes when it resolves. */
  readonly onSubmit: () => Promise<unknown>
  /** Told about a failure before it is shown (to remember a refusal). */
  readonly onFailure?: (error: unknown) => void
  readonly children: ReactNode
}): ReactNode {
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [tried, setTried] = useState(false)
  const inFlight = useRef(false)

  const change = (open: boolean): void => {
    if (pending) return
    if (!open) {
      setError(undefined)
      setTried(false)
    }
    props.onOpenChange(open)
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setTried(true)
    if (inFlight.current || props.problem !== undefined) return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    try {
      await props.onSubmit()
      setTried(false)
      props.onOpenChange(false)
    } catch (failure) {
      props.onFailure?.(failure)
      setError(describeError(failure))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={change}>
      <DialogContent size="medium">
        <form noValidate onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4">
            {props.children}
            {tried && props.problem !== undefined ? (
              <p role="alert" className="m-0 text-sm text-destructive" data-problem="">
                {props.problem}
              </p>
            ) : null}
            {error === undefined ? null : (
              <p role="alert" className="m-0 text-sm text-destructive" data-failure="">
                {error}
              </p>
            )}
          </DialogSection>
          <DialogFooter>
            <Button
              type="button"
              variant="default"
              disabled={pending}
              onClick={() => change(false)}
            >
              {t('wave9.dialog.cancel')}
            </Button>
            <Button
              type="submit"
              variant={props.destructive === true ? 'danger' : 'primary'}
              loading={pending}
            >
              {props.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
