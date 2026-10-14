import { createFileRoute } from '@tanstack/react-router'
import { ProductsPage } from '../../../features/settings/products-page.tsx'

/** Products of the registry; a new one is a plan. */
export const Route = createFileRoute('/_app/settings/products')({
  component: ProductsPage,
})
