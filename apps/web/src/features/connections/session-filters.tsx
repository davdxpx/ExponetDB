import { Button, Input } from '@exponetdb/ui'
import { type ChangeEvent, type ReactNode, useId } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { plainLabel, stateLabel } from './model.ts'
import {
  type ConnectionsSearch,
  MIN_AGE_SECONDS,
  type MinAgeSeconds,
  STATE_FILTERS,
} from './search.ts'

/** The most text the search accepts: a filter, not a place to paste a statement. */
const SEARCH_MAX_LENGTH = 200

const MIN_AGE_KEYS: Readonly<Record<MinAgeSeconds, MessageKey>> = {
  10: 'connections.filters.minAge.10',
  60: 'connections.filters.minAge.60',
  300: 'connections.filters.minAge.300',
  1800: 'connections.filters.minAge.1800',
}

const selectClass =
  'h-8 max-w-56 rounded-md border border-default bg-surface-100 px-2 text-sm focus-ring'

/**
 * The filters and the arrangement of the sessions list.
 *
 * - **State**, **minimum age**, **blockers only**, **longest first** and the
 *   **layout** are parameters of the address: each is one of a fixed list,
 *   so a link can share a view and nothing else ever reaches the page.
 * - **Role** and **application** are equality selects whose options come
 *   from the loaded sessions; the chosen value is held by the page (never in
 *   the address) and compared for equality, so a role named like markup or
 *   a parameter is only ever a string that equals itself.
 * - The **text search** is typed here, matched against the redacted
 *   statements the list shows, and never leaves the page.
 */
export function SessionFilterBar(props: {
  readonly search: ConnectionsSearch
  readonly onSearchChange: (next: ConnectionsSearch) => void
  readonly role: string | undefined
  readonly onRoleChange: (role: string | undefined) => void
  readonly application: string | undefined
  readonly onApplicationChange: (application: string | undefined) => void
  readonly text: string
  readonly onTextChange: (text: string) => void
  /** The roles and application names of the loaded sessions. */
  readonly roles: readonly string[]
  readonly applications: readonly string[]
  readonly active: boolean
  readonly onReset: () => void
}): ReactNode {
  const { search } = props
  const textId = useId()
  return (
    <form
      aria-label={t('connections.filters.label')}
      className="flex flex-col gap-3"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('connections.filters.state')}>
          {(id) => (
            <select
              id={id}
              className={selectClass}
              value={search.state ?? ''}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                props.onSearchChange({
                  ...search,
                  state: STATE_FILTERS.find((candidate) => candidate === event.target.value),
                })
              }
            >
              <option value="">{t('connections.filters.any')}</option>
              {STATE_FILTERS.map((state) => (
                <option key={state} value={state}>
                  {stateLabel(state)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('connections.filters.minAge')}>
          {(id) => (
            <select
              id={id}
              className={selectClass}
              value={search.minAge === undefined ? '' : String(search.minAge)}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                props.onSearchChange({
                  ...search,
                  minAge: MIN_AGE_SECONDS.find(
                    (candidate) => String(candidate) === event.target.value,
                  ),
                })
              }
            >
              <option value="">{t('connections.filters.any')}</option>
              {MIN_AGE_SECONDS.map((seconds) => (
                <option key={seconds} value={String(seconds)}>
                  {t(MIN_AGE_KEYS[seconds])}
                </option>
              ))}
            </select>
          )}
        </Field>
        <DataSelect
          label={t('connections.filters.role')}
          value={props.role}
          values={props.roles}
          onChange={props.onRoleChange}
          emptyName={t('connections.filters.emptyName')}
        />
        <DataSelect
          label={t('connections.filters.application')}
          value={props.application}
          values={props.applications}
          onChange={props.onApplicationChange}
          emptyName={t('connections.group.noApplication')}
        />
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <label htmlFor={textId} className="text-sm font-medium">
            {t('connections.filters.text')}
          </label>
          <Input
            id={textId}
            type="search"
            size="tiny"
            autoComplete="off"
            spellCheck={false}
            maxLength={SEARCH_MAX_LENGTH}
            placeholder={t('connections.filters.text.placeholder')}
            value={props.text}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              props.onTextChange(event.target.value)
            }
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="tiny"
          variant={search.view === 'blockers' ? 'default' : 'outline'}
          aria-pressed={search.view === 'blockers'}
          onClick={() =>
            props.onSearchChange({
              ...search,
              view: search.view === 'blockers' ? undefined : 'blockers',
            })
          }
        >
          {t('connections.filters.blockers')}
        </Button>
        <Button
          type="button"
          size="tiny"
          variant={search.sort === 'longest' ? 'default' : 'outline'}
          aria-pressed={search.sort === 'longest'}
          onClick={() =>
            props.onSearchChange({
              ...search,
              sort: search.sort === 'longest' ? undefined : 'longest',
            })
          }
        >
          {t('connections.filters.sort')}
        </Button>
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">{t('connections.filters.layout')}</legend>
          <Button
            type="button"
            size="tiny"
            variant={search.layout === undefined ? 'default' : 'outline'}
            aria-pressed={search.layout === undefined}
            onClick={() => props.onSearchChange({ ...search, layout: undefined })}
          >
            {t('connections.filters.layout.grouped')}
          </Button>
          <Button
            type="button"
            size="tiny"
            variant={search.layout === 'flat' ? 'default' : 'outline'}
            aria-pressed={search.layout === 'flat'}
            onClick={() => props.onSearchChange({ ...search, layout: 'flat' })}
          >
            {t('connections.filters.layout.flat')}
          </Button>
        </fieldset>
        {props.active ? (
          <Button type="button" size="tiny" variant="text" onClick={props.onReset}>
            {t('connections.filters.reset')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}

function Field(props: {
  readonly label: string
  readonly children: (id: string) => ReactNode
}): ReactNode {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {props.label}
      </label>
      {props.children(id)}
    </div>
  )
}

/**
 * An equality filter over values the data holds. The options carry the
 * position of a value, not the value, so a name can never be mistaken for
 * "any"; the chosen value is kept even after it has left the data, so the
 * select never silently shows another one. Names are shown as plain text with
 * every invisible or direction character spelled out by its code point.
 */
function DataSelect(props: {
  readonly label: string
  readonly value: string | undefined
  readonly values: readonly string[]
  readonly onChange: (value: string | undefined) => void
  /** What an empty name is called. */
  readonly emptyName: string
}): ReactNode {
  const options =
    props.value !== undefined && !props.values.includes(props.value)
      ? [...props.values, props.value]
      : props.values
  const selected = props.value === undefined ? '' : String(options.indexOf(props.value))
  return (
    <Field label={props.label}>
      {(id) => (
        <select
          id={id}
          className={selectClass}
          value={selected}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            const index = event.target.value
            props.onChange(index === '' ? undefined : options[Number(index)])
          }}
        >
          <option value="">{t('connections.filters.any')}</option>
          {options.map((value, index) => (
            <option key={value} value={String(index)}>
              {value === '' ? props.emptyName : plainLabel(value)}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}
