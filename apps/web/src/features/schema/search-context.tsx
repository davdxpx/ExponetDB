import { createContext, type ReactNode, useContext, useMemo } from 'react'
import type { SchemaSearch } from './search.ts'

/**
 * The validated search of the schema kind page and the way to change it,
 * handed down from the route (`Route.useSearch()` and `Route.useNavigate()`),
 * so the components of the browser stay free of the router. A change replaces
 * the whole search; `replace` keeps the history clean for changes that are not
 * a place of their own (typing a filter, sorting), while selecting an object
 * is a step the back button returns from.
 */
export interface SchemaSearchValue {
  readonly search: SchemaSearch
  readonly setSearch: (next: SchemaSearch, options?: { readonly replace?: boolean }) => void
}

const SchemaSearchContext = createContext<SchemaSearchValue | undefined>(undefined)

export function SchemaSearchProvider(props: {
  readonly search: SchemaSearch
  readonly onSearch: (next: SchemaSearch, options?: { readonly replace?: boolean }) => void
  readonly children: ReactNode
}): ReactNode {
  const { search, onSearch } = props
  const value = useMemo(() => ({ search, setSearch: onSearch }), [search, onSearch])
  return <SchemaSearchContext.Provider value={value}>{props.children}</SchemaSearchContext.Provider>
}

export function useSchemaSearch(): SchemaSearchValue {
  const value = useContext(SchemaSearchContext)
  if (value === undefined) {
    throw new Error('useSchemaSearch() outside the schema kind page')
  }
  return value
}
