import type { SavedQuery } from '@exponetdb/sdk/operations'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
  Input,
  Label,
} from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { describeError, t } from '../../lib/i18n/i18n.ts'

/**
 * "Save query" for a tab that holds no saved query of the person's own: a
 * name, who sees it (only me, everyone who may read data in the scope) and
 * the scope that never changes (this target, the whole project). Saving
 * stores the text; it never runs, admits or classifies it.
 */
export interface SaveInput {
  readonly name: string
  readonly visibility: 'personal' | 'project'
  readonly scope: 'target' | 'project'
}

export const SAVED_NAME_MAX = 120

export function SaveDialog(props: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly initialName: string
  readonly onSave: (input: SaveInput) => Promise<SavedQuery>
}): ReactNode {
  const id = useId()
  const [name, setName] = useState(props.initialName)
  const [visibility, setVisibility] = useState<'personal' | 'project'>('personal')
  const [scope, setScope] = useState<'target' | 'project'>('target')
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const trimmed = name.trim()
  const tooLong = [...trimmed].length > SAVED_NAME_MAX

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (pending || trimmed.length === 0 || tooLong) return
    setPending(true)
    setError(undefined)
    try {
      await props.onSave({ name: trimmed, visibility, scope })
      props.onOpenChange(false)
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent size="small">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t('sql.save.title')}</DialogTitle>
            <DialogDescription>{t('sql.save.description')}</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>{t('sql.save.name')}</Label>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-describedby={`${id}-name-hint`}
                aria-invalid={tooLong || undefined}
                autoComplete="off"
              />
              <p id={`${id}-name-hint`} className="text-xs text-foreground-lighter">
                {tooLong
                  ? t('sql.save.nameTooLong', { max: SAVED_NAME_MAX })
                  : t('sql.save.nameHint')}
              </p>
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm">{t('sql.save.visibility')}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-visibility`}
                  checked={visibility === 'personal'}
                  onChange={() => setVisibility('personal')}
                />
                {t('sql.save.personal')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-visibility`}
                  checked={visibility === 'project'}
                  onChange={() => setVisibility('project')}
                />
                {t('sql.save.shared')}
              </label>
            </fieldset>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm">{t('sql.save.scope')}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-scope`}
                  checked={scope === 'target'}
                  onChange={() => setScope('target')}
                />
                {t('sql.save.scopeTarget')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-scope`}
                  checked={scope === 'project'}
                  onChange={() => setScope('project')}
                />
                {t('sql.save.scopeProject')}
              </label>
              <p className="text-xs text-foreground-lighter">{t('sql.save.scopeHint')}</p>
            </fieldset>
            {error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => props.onOpenChange(false)}>
              {t('sql.save.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={pending || trimmed.length === 0 || tooLong}
            >
              {t('sql.save.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
