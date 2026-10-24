import {
  Button,
  ComboboxTrigger,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exponetdb/ui'
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { SEARCH_MAX_LENGTH } from './keys.ts'
import { PlainName } from './plain-name.tsx'

/**
 * The name filter of the schema browser: optional, 1 to 128 characters, sent
 * as `q`. Without one the list shows every object of the kind.
 */
export function SearchForm(props: {
  readonly applied: string
  readonly onApply: (term: string) => void
  readonly label?: string
}): ReactNode {
  const id = useId()
  const [draft, setDraft] = useState(props.applied)
  // A link or the back button changes the applied filter: the field follows it.
  useEffect(() => setDraft(props.applied), [props.applied])
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    props.onApply(draft.trim().slice(0, SEARCH_MAX_LENGTH))
  }
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <div className="flex min-w-60 flex-1 flex-col gap-1.5">
        <Label htmlFor={id}>{props.label ?? t('schema.search.label')}</Label>
        <Input
          id={id}
          value={draft}
          maxLength={SEARCH_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          aria-describedby={`${id}-hint`}
        />
      </div>
      <Button type="submit" variant="default">
        {t('schema.search.apply')}
      </Button>
      <p id={`${id}-hint`} className="basis-full text-xs text-foreground-light">
        {t('schema.search.hint')}
      </p>
    </form>
  )
}

/** Most schemas the list shows at once; the rest are reached by typing in the field. */
export const SCHEMA_SELECTOR_LIMIT = 100

export interface SchemaChoice {
  readonly name: string
  readonly managed: boolean
}

/** The schemas in the order the selector lists them: managed by ExponetDB first, each group by name. */
export function orderSchemas(schemas: readonly SchemaChoice[]): readonly SchemaChoice[] {
  return [...schemas].sort(
    (a, b) =>
      Number(b.managed) - Number(a.managed) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

/**
 * Chooses one schema, or all: a searchable list over the schemas of the
 * overview. Schema names are untrusted, so they are not the text of a native
 * `<select>` (a direction character would act there); each is shown through
 * `PlainName`, with hidden characters by code point. Options are matched by
 * their position in the list, never by their text, so a name with leading
 * spaces or unusual characters is still chosen exactly.
 */
export function SchemaSelector(props: {
  readonly schemas: readonly SchemaChoice[]
  readonly value: string | null
  readonly onChange: (schema: string | null) => void
}): ReactNode {
  const labelId = useId()
  const valueId = useId()
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const ordered = useMemo(() => orderSchemas(props.schemas), [props.schemas])
  const needle = term.trim().toLowerCase()
  const matches = useMemo(
    () => ordered.filter((entry) => needle === '' || entry.name.toLowerCase().includes(needle)),
    [ordered, needle],
  )
  const shown = matches.slice(0, SCHEMA_SELECTOR_LIMIT)
  const managed = shown.filter((entry) => entry.managed)
  const others = shown.filter((entry) => !entry.managed)
  const choose = (schema: string | null): void => {
    props.onChange(schema)
    setOpen(false)
    setTerm('')
  }
  const item = (entry: SchemaChoice): ReactNode => (
    <CommandItem
      key={entry.name}
      value={`schema:${ordered.indexOf(entry)}`}
      onSelect={() => choose(entry.name)}
      data-current={props.value === entry.name ? 'true' : undefined}
    >
      <PlainName text={entry.name} mono max={80} />
    </CommandItem>
  )
  return (
    <div className="flex flex-col gap-1.5" data-slot="schema-selector">
      <span id={labelId} className="text-sm font-medium">
        {t('schema.selector.label')}
      </span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setTerm('')
        }}
      >
        <PopoverTrigger asChild>
          <ComboboxTrigger
            className="w-72"
            aria-labelledby={`${labelId} ${valueId}`}
            aria-expanded={open}
          >
            <span id={valueId}>
              {props.value === null ? (
                t('schema.selector.all')
              ) : (
                <PlainName text={props.value} mono max={40} />
              )}
            </span>
          </ComboboxTrigger>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command label={t('schema.selector.search')} shouldFilter={false}>
            <CommandInput
              value={term}
              onValueChange={setTerm}
              placeholder={t('schema.selector.search')}
            />
            <CommandList>
              <CommandEmpty>{t('schema.selector.empty')}</CommandEmpty>
              {needle === '' ? (
                <CommandGroup>
                  <CommandItem value="schema:all" onSelect={() => choose(null)}>
                    {t('schema.selector.all')}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {managed.length === 0 ? null : (
                <CommandGroup heading={t('schema.selector.managed')}>
                  {managed.map(item)}
                </CommandGroup>
              )}
              {others.length === 0 ? null : (
                <CommandGroup heading={t('schema.selector.others')}>
                  {others.map(item)}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
          {matches.length > shown.length ? (
            <p className="border-t border-default px-3 py-2 text-xs text-foreground-light">
              {t('schema.selector.shown', { shown: shown.length, total: matches.length })}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}
