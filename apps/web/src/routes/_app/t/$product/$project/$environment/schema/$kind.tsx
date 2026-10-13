import { createFileRoute } from '@tanstack/react-router'
import { isSchemaKind } from '../../../../../../../features/target/params.ts'
import { TargetSectionPage } from '../../../../../../../features/target/section-page.tsx'
import { NotFoundPage } from '../../../../../../../shell/not-found.tsx'

/**
 * `/t/<product>/<project>/<environment>/schema/<kind>`: the kind must be one
 * of the schema object kinds (never an object's own name), else "page not found".
 */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/schema/$kind')({
  component: SchemaKindPage,
})

function SchemaKindPage() {
  const { kind } = Route.useParams()
  return isSchemaKind(kind) ? <TargetSectionPage section="schema" kind={kind} /> : <NotFoundPage />
}
