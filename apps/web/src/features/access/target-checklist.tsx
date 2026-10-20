import type { Tier } from '@exponetdb/contracts'
import { Button, Checkbox, Input, Label } from '@exponetdb/ui'
import { TierChip, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { inlineName } from '../consent/inline-name.ts'
import { AUTHORITY_MAX_TARGETS, isTargetId } from './authority.ts'
import { ChoiceNote, choiceReadable } from './choice-select.tsx'
import { tierLabel } from './model.ts'
import { targetChoicesQuery } from './scope-reads.ts'

/**
 * The targets an API key or a machine grant is limited to: a searchable list
 * of the registry's targets with a check box each, up to the contract's
 * maximum, and a field to add a target by its ID when the read is cut, fails
 * or does not list it. The paths are untrusted text. The IDs chosen are the
 * value; the server checks that each exists and that the roles reach it. The
 * list is read only when this control is shown (the person chose "only these
 * targets"), and a read that fails or is cut says so and never looks like an
 * empty registry.
 */
export function TargetChecklist({
  value,
  onChange,
  tiers,
}: {
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
  /** The tiers chosen for the authority, to point out a chosen target outside them. */
  readonly tiers: readonly Tier[]
}): ReactNode {
  const { client } = useApi()
  const base = useId()
  const targets = useQuery(targetChoicesQuery(client))
  const readable = choiceReadable(targets)
  const [search, setSearch] = useState('')
  const [typed, setTyped] = useState('')
  const [typedError, setTypedError] = useState(false)
  const atMost = value.length >= AUTHORITY_MAX_TARGETS

  const items =
    readable.state === 'loading' || readable.state === 'failed' ? [] : readable.value.items
  const needle = search.trim().toLowerCase()
  const shown =
    needle === '' ? items : items.filter((target) => target.path.toLowerCase().includes(needle))
  const listed = new Set(items.map((target) => target.id))
  const unlisted = value.filter((id) => !listed.has(id))
  const outside = items.filter(
    (target) => value.includes(target.id) && !tiers.includes(target.tier),
  )

  const toggle = (id: string, checked: boolean): void => {
    onChange(
      checked
        ? [...value.filter((entry) => entry !== id), id]
        : value.filter((entry) => entry !== id),
    )
  }

  const add = (): void => {
    const id = typed.trim()
    if (!isTargetId(id)) {
      setTypedError(true)
      return
    }
    setTypedError(false)
    setTyped('')
    if (!value.includes(id) && !atMost) onChange([...value, id])
  }

  return (
    <fieldset className="flex flex-col gap-3" data-target-checklist="">
      <legend className="text-sm text-foreground">{t('access.authority.targets.choose')}</legend>
      <p className="text-xs text-foreground-light" role="status">
        {t('access.authority.targets.count', { count: value.length, max: AUTHORITY_MAX_TARGETS })}
      </p>
      <ChoiceNote
        id={`${base}-note`}
        readable={readable}
        error={targets.error}
        what={t('choice.what.targets')}
        permission="targets.read"
        empty={readable.state === 'ready' && items.length === 0}
        onRetry={() => void targets.refetch()}
      />
      {items.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <div className="max-w-sm">
            <Label htmlFor={`${base}-search`} className="sr-only">
              {t('access.authority.targets.search')}
            </Label>
            <Input
              id={`${base}-search`}
              type="search"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('access.authority.targets.search')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              // Enter in the search must not send the form it sits in.
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault()
              }}
            />
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-foreground-light" data-no-match="">
              {t('access.authority.targets.noMatch')}{' '}
              <Button type="button" variant="text" size="tiny" onClick={() => setSearch('')}>
                {t('access.authority.targets.clearSearch')}
              </Button>
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto rounded-md border border-default p-2">
              {shown.map((target) => {
                const checked = value.includes(target.id)
                const id = `${base}-${target.id}`
                return (
                  <li key={target.id} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={!checked && atMost}
                      onCheckedChange={(next) => toggle(target.id, next === true)}
                    />
                    <Label
                      htmlFor={id}
                      className="flex flex-wrap items-center gap-2 text-sm text-foreground"
                    >
                      <UntrustedName
                        name={target.path}
                        mono
                        label={t('access.authority.targets.path')}
                      />
                      <TierChip tier={target.tier} />
                    </Label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
      {unlisted.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-foreground-light">{t('access.authority.targets.unlisted')}</p>
          <ul className="flex flex-col gap-1">
            {unlisted.map((id) => (
              <li key={id} className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{id}</code>
                <Button
                  type="button"
                  variant="text"
                  size="tiny"
                  aria-label={t('access.authority.targets.remove', { id })}
                  onClick={() => toggle(id, false)}
                >
                  {t('access.authority.targets.removeAction')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {outside.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-xs text-foreground-light">
          {outside.map((target) => (
            <li key={target.id}>
              {t('access.authority.targets.tierMismatch', {
                // Plain text in a sentence: hidden and direction characters are named, never applied.
                path: inlineName(target.path, 80) ?? target.id,
                tier: tierLabel(target.tier),
              })}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${base}-add`}>{t('access.authority.targets.add')}</Label>
        <div className="flex flex-wrap items-start gap-2">
          <Input
            id={`${base}-add`}
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            className="max-w-sm font-mono"
            value={typed}
            aria-invalid={typedError}
            aria-describedby={typedError ? `${base}-add-error` : undefined}
            disabled={atMost}
            onChange={(event) => {
              setTyped(event.target.value)
              setTypedError(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              }
            }}
          />
          <Button type="button" variant="default" size="small" disabled={atMost} onClick={add}>
            {t('access.authority.targets.addAction')}
          </Button>
        </div>
        {typedError ? (
          <p id={`${base}-add-error`} role="alert" className="text-xs text-destructive">
            {t('people.binding.scopeId.invalid', { prefix: 'tgt_' })}
          </p>
        ) : null}
        {atMost ? (
          <p className="text-xs text-foreground-light">
            {t('access.authority.targets.atMost', { max: AUTHORITY_MAX_TARGETS })}
          </p>
        ) : null}
      </div>
    </fieldset>
  )
}
