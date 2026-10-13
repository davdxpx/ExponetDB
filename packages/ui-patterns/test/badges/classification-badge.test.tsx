import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ClassificationBadge,
  type StatementClassification,
} from '../../src/badges/classification-badge.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const CASES: readonly (readonly [StatementClassification, string, string])[] = [
  ['destructive', 'Destructive', 'Removes data or objects that only a backup can bring back.'],
  ['rewrite', 'Rewrite', 'Rewrites a whole table and holds a lock on it until the rewrite ends.'],
  [
    'non_transactional',
    'Non-transactional',
    'Runs outside a transaction, so a failure can leave the change half applied.',
  ],
  ['security', 'Security', 'Changes roles, grants, policies or other access to data.'],
  ['read_only', 'Read-only', 'Reads data and changes nothing.'],
  ['write', 'Write', 'Changes data or the schema.'],
]

function renderBadge(classification: StatementClassification) {
  return render(
    <TooltipProvider delayDuration={0}>
      {/* Badge renders a div (packages/ui), so the container is not a paragraph. */}
      <div>
        Statement 3 <ClassificationBadge classification={classification} />
      </div>
    </TooltipProvider>,
  )
}

describe('ClassificationBadge', () => {
  it.each(CASES)('shows %s with an icon and its name', (classification, label) => {
    renderBadge(classification)
    const badge = screen.getByText(label).parentElement
    expect(badge).toHaveAttribute('data-classification', classification)
    expect(badge?.querySelector('svg')).not.toBeNull()
  })

  it.each(CASES)(
    'explains %s in one sentence on keyboard focus',
    async (classification, label, explanation) => {
      const user = userEvent.setup()
      renderBadge(classification)
      await user.tab()
      const badge = screen.getByText(label).parentElement
      expect(badge).toHaveFocus()
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent(explanation)
      expect(badge).toHaveAccessibleDescription(explanation)
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    },
  )

  it('shows a class it does not know by its name, as text', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <ClassificationBadge
          classification={'<b>future_class</b>' as unknown as StatementClassification}
        />
      </TooltipProvider>,
    )
    expect(screen.getByText('<b>future_class</b>')).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
  })

  it('has no axe violations, also with the tooltip open', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider delayDuration={0}>
        <ul>
          {CASES.map(([classification]) => (
            <li key={classification}>
              <ClassificationBadge classification={classification} />
            </li>
          ))}
        </ul>
      </TooltipProvider>,
    )
    expect(await axeViolations()).toEqual([])
    await user.tab()
    await screen.findByRole('tooltip')
    expect(await axeViolations()).toEqual([])
  })
})
