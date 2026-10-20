import { Checkbox } from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * The bundles a person picked in a list, kept per list identity (`scope`):
 * a list that shows other bundles (another environment) starts empty again.
 * Only ids the list still shows count as picked.
 */
export function useBundleSelection(
  scope: string,
  shown: readonly string[],
): {
  readonly selected: readonly string[]
  readonly isSelected: (id: string) => boolean
  readonly toggle: (id: string, on: boolean) => void
  readonly setAll: (on: boolean) => void
} {
  const [state, setState] = useState<{ readonly scope: string; readonly ids: readonly string[] }>({
    scope,
    ids: [],
  })
  const ids = state.scope === scope ? state.ids : []
  const selected = shown.filter((id) => ids.includes(id))
  return {
    selected,
    isSelected: (id) => selected.includes(id),
    toggle: (id, on) =>
      setState({
        scope,
        ids: on ? [...selected.filter((s) => s !== id), id] : selected.filter((s) => s !== id),
      }),
    setAll: (on) => setState({ scope, ids: on ? [...shown] : [] }),
  }
}

/** The checkbox of one bundle row; its name is the bundle id (a validated ULID). */
export function BundleCheckbox({
  migrationId,
  checked,
  onChange,
}: {
  readonly migrationId: string
  readonly checked: boolean
  readonly onChange: (on: boolean) => void
}): ReactNode {
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={(value) => onChange(value === true)}
      aria-label={t('promote.select.one', { migration: migrationId })}
      data-select-bundle={migrationId}
    />
  )
}

/** "Select all" of a bundle list: checked, unchecked or partly checked. */
export function SelectAllCheckbox({
  total,
  selected,
  onChange,
}: {
  readonly total: number
  readonly selected: number
  readonly onChange: (on: boolean) => void
}): ReactNode {
  const state = selected === 0 ? false : selected === total ? true : 'indeterminate'
  return (
    <Checkbox
      checked={state}
      disabled={total === 0}
      onCheckedChange={(value) => onChange(value === true)}
      aria-label={t('promote.select.all')}
    />
  )
}
