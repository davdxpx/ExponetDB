import { createFileRoute } from '@tanstack/react-router'
import { promotionSearch } from '../../../features/changes/model.ts'
import { PromotionPage } from '../../../features/changes/promotion-page.tsx'

/** `/changes/promotion?project=prj_…`: the promotion view of one project's migration stream. */
export const Route = createFileRoute('/_app/changes/promotion')({
  validateSearch: promotionSearch,
  component: PromotionRoute,
})

function PromotionRoute() {
  const search = Route.useSearch()
  return <PromotionPage search={search} />
}
