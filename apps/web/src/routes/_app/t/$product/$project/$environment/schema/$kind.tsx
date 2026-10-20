import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import {
  cleanSearch,
  type SchemaSearch,
  schemaSearch,
} from '../../../../../../../features/schema/search.ts'
import { SchemaSearchProvider } from '../../../../../../../features/schema/search-context.tsx'
import { isSchemaKind } from '../../../../../../../features/target/params.ts'
import { TargetSectionPage } from '../../../../../../../features/target/section-page.tsx'
import { NotFoundPage } from '../../../../../../../shell/not-found.tsx'

/**
 * `/t/<product>/<project>/<environment>/schema/<kind>`: the kind must be one
 * of the schema object kinds (never an object's own name), else "page not found".
 * The selected object, the name filter, the schema, the tab and the row
 * browser's sort and filters live in validated search parameters, so a link
 * carries them; an object's name travels as a validated key in the search,
 * never in the path.
 */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/schema/$kind')({
  validateSearch: schemaSearch,
  component: SchemaKindPage,
})

function SchemaKindPage() {
  const { kind } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback(
    (next: SchemaSearch, options?: { readonly replace?: boolean }) =>
      void navigate({ search: cleanSearch(next), replace: options?.replace ?? false }),
    [navigate],
  )
  return isSchemaKind(kind) ? (
    <SchemaSearchProvider search={search} onSearch={onSearch}>
      <TargetSectionPage section="schema" kind={kind} />
    </SchemaSearchProvider>
  ) : (
    <NotFoundPage />
  )
}
