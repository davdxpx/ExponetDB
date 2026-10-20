import { ChevronDown } from '@exponetdb/icons'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
} from '@exponetdb/ui'
import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { sqlKeys } from './keys.ts'
import { checkSavedName, SAVED_NAME_MAX } from './sql-model.ts'

/**
 * What the owner of a saved query can do with it besides editing its text:
 * rename it, change who sees it and save it again as a copy. The menu is
 * shown to the owner only (the server enforces it; the page hides what it
 * would refuse, as it does for Delete). A change never carries text of the
 * person's own: it is made against the stored version, read just before, so
 * renaming a query can never save the edits of an open tab, and the scope
 * never changes.
 */
type Visibility = SavedQuery['visibility']

export function SavedMenu(props: {
  readonly visibility: Visibility
  /** The accessible name of the trigger. */
  readonly label: string
  /** Names the saved query for assistive technology (an element id on the page). */
  readonly describedBy?: string
  /** An icon-only trigger, for a tab; the default has the word "Actions". */
  readonly iconOnly?: boolean
  readonly busy?: boolean
  readonly onRename: () => void
  readonly onVisibility: (visibility: Visibility) => void
  readonly onCopy: () => void
}): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="tiny"
          disabled={props.busy === true}
          aria-label={props.iconOnly === true ? props.label : undefined}
          aria-describedby={props.describedBy}
          iconRight={<ChevronDown className="size-3" />}
        >
          {props.iconOnly === true ? <span className="sr-only">{props.label}</span> : props.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 max-w-[calc(100vw-1rem)]">
        <DropdownMenuItem onSelect={props.onRename}>{t('sql.saved.menuRename')}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('sql.saved.menuVisibility')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={props.visibility}
          onValueChange={(next) => {
            if (next === 'personal' || next === 'project') props.onVisibility(next)
          }}
        >
          <DropdownMenuRadioItem value="personal">
            {t('sql.saved.menuPersonal')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="project">{t('sql.saved.menuShared')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={props.onCopy}>{t('sql.saved.menuCopy')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Renames a saved query: the same name rules as the save dialog, nothing else changes. */
export function RenameDialog(props: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly initialName: string
  readonly onRename: (name: string) => Promise<void>
}): ReactNode {
  const id = useId()
  const [name, setName] = useState(props.initialName)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const check = checkSavedName(name)
  const trimmed = name.trim()

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (pending || check !== 'ok') return
    setPending(true)
    setError(undefined)
    try {
      await props.onRename(trimmed)
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
            <DialogTitle>{t('sql.rename.title')}</DialogTitle>
            <DialogDescription>{t('sql.rename.description')}</DialogDescription>
          </DialogHeader>
          <DialogSection className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>{t('sql.save.name')}</Label>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-describedby={`${id}-name-hint`}
                aria-invalid={check === 'too_long' || undefined}
                autoComplete="off"
              />
              <p id={`${id}-name-hint`} className="text-xs text-foreground-lighter">
                {check === 'too_long'
                  ? t('sql.save.nameTooLong', { max: SAVED_NAME_MAX })
                  : t('sql.save.nameHint')}
              </p>
            </div>
            {error === undefined ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogSection>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => props.onOpenChange(false)}>
              {t('sql.rename.cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={pending || check !== 'ok'}>
              {t('sql.rename.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The stored version a change was made against, and the version it produced. */
export interface SavedChange {
  readonly before: SavedQuery
  readonly after: SavedQuery
}

/**
 * Changes of a saved query. Each reads the stored version first and writes
 * the change at that revision with the stored text, so only the name or the
 * visibility moves; a revision that changed in between is a `CONFLICT` the
 * caller shows. A change asks for a fresh identity check like every other
 * change of a saved query (`withReauth`), and the saved lists are read again
 * afterwards.
 */
export function useSavedChanges(path: string): {
  readonly rename: (id: string, name: string) => Promise<SavedChange>
  readonly setVisibility: (id: string, visibility: Visibility) => Promise<SavedChange>
} {
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const change = async (
    id: string,
    pick: (stored: SavedQuery) => { name: string; visibility: Visibility },
  ): Promise<SavedChange> => {
    try {
      const before = await client.operation('getSavedQuery', { params: { savedQueryId: id } })
      const next = pick(before)
      const after = await withReauth(client, confirmIdentity, () =>
        client.operation('updateSavedQuery', {
          params: { savedQueryId: id },
          body: {
            name: next.name,
            sql: before.sql,
            visibility: next.visibility,
            revision: before.revision,
          },
        }),
      )
      return { before, after }
    } finally {
      void queryClient.invalidateQueries({ queryKey: sqlKeys.saved(path) })
    }
  }
  return {
    rename: (id, name) => change(id, (stored) => ({ name, visibility: stored.visibility })),
    setVisibility: (id, visibility) => change(id, (stored) => ({ name: stored.name, visibility })),
  }
}
