import { createFileRoute } from '@tanstack/react-router'
import { ApprovalsPage } from '../../features/approvals/approvals-page.tsx'

/**
 * `/approvals`: the approvals queue. `/approvals#operation=op_…` (the link
 * the server, the CLI and MCP emit) opens the review page of that
 * operation's plan.
 */
export const Route = createFileRoute('/_app/approvals')({
  component: ApprovalsPage,
})
