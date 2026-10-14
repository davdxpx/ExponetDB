import { createFileRoute } from '@tanstack/react-router'
import { RegisterTargetPage } from '../../../features/targets/register-page.tsx'

/** `/targets/register`: register a target as a plan. */
export const Route = createFileRoute('/_app/targets/register')({
  component: RegisterTargetPage,
})
