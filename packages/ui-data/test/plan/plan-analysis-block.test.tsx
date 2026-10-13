import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type MigrationAnalysisView,
  PlanAnalysisBlock,
} from '../../src/plan/plan-analysis-block.tsx'
import { axeViolations } from '../support/axe.ts'
import { RLO, renderPlan, ZWSP } from './support.tsx'

afterEach(cleanup)

const MIGRATION: MigrationAnalysisView = {
  migrationId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  name: `add_orders${RLO}`,
  compatibility: { declared: 'additive', observed: 'destructive', disagree: true },
  lockSeverity: 'critical',
  statements: [
    {
      index: 0,
      line: 1,
      kind: 'CREATE TABLE',
      lock: 'none',
      compatibility: 'additive',
      rewrite: 'none',
      transactional: true,
      coverage: 'derived',
    },
    {
      index: 1,
      line: 4,
      kind: 'DROP TABLE',
      lock: { mode: 'ACCESS EXCLUSIVE', severity: 'critical' },
      compatibility: 'destructive',
      rewrite: 'none',
      transactional: true,
      coverage: 'derived',
    },
    {
      index: 2,
      line: 7,
      kind: 'CREATE INDEX CONCURRENTLY',
      lock: 'none',
      compatibility: 'unknown',
      rewrite: 'possible',
      transactional: false,
      coverage: 'underived',
    },
  ],
  drops: [`public.users${ZWSP}`],
  rewrites: [{ relation: 'public.orders', rows: 1_200_000, bytes: null }],
  rollback: { available: false },
  checksum: `sha256:c1:${'0f'.repeat(32)}`,
}

function statementRow(index: number): HTMLTableRowElement {
  const row = document.querySelector(`tr[data-statement="${index}"]`)
  if (!(row instanceof HTMLTableRowElement)) throw new Error(`no statement ${index}`)
  return row
}

describe('PlanAnalysisBlock', () => {
  it('lists every statement with its line, kind, lock, compatibility, rewrite and classes', async () => {
    renderPlan(
      <PlanAnalysisBlock
        overall={{
          compatibility: 'destructive',
          lockSeverity: 'critical',
          destructive: true,
          nontransactional: true,
        }}
        migrations={[MIGRATION]}
      />,
    )
    const drop = statementRow(1)
    expect(drop).toHaveTextContent('#2')
    expect(drop).toHaveTextContent('4')
    expect(drop).toHaveTextContent('DROP TABLE')
    expect(drop).toHaveTextContent('ACCESS EXCLUSIVE')
    expect(drop).toHaveTextContent('Destructive')
    expect(drop).toHaveAttribute('data-destructive')
    expect(drop.querySelector('[data-classification="destructive"]')).not.toBeNull()
    const concurrent = statementRow(2)
    expect(concurrent).toHaveTextContent('Rewrite')
    expect(concurrent).toHaveTextContent('Non-transactional')
    expect(screen.getByText('Yes: the plan drops objects')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('never shows a lock or a class it could not derive as safe', () => {
    renderPlan(<PlanAnalysisBlock overall={null} migrations={[MIGRATION]} />)
    // A derived statement without a lock: none.
    expect(statementRow(0).cells[3]).toHaveTextContent('None')
    // A statement the analysis could not derive: its missing lock is not known, not "none".
    expect(statementRow(2).cells[3]).toHaveTextContent('not known (not fully analyzed)')
    expect(statementRow(2).cells[4]).toHaveTextContent('not known')
    expect(statementRow(2).cells[4]).not.toHaveTextContent('Additive')
  })

  it('shows the migration name, the drops and the rewrites as untrusted text', () => {
    renderPlan(<PlanAnalysisBlock overall={null} migrations={[MIGRATION]} />)
    const section = document.querySelector('section[data-migration]') as HTMLElement
    expect(section).toHaveTextContent('⟨U+202E⟩')
    expect(section).toHaveTextContent('⟨U+200B⟩')
    expect(section.textContent).not.toContain(RLO)
    expect(section.textContent).not.toContain(ZWSP)
    expect(section.querySelector('li.destructive')).toHaveTextContent('public.users')
    expect(section).toHaveTextContent('about 1,200,000 rows, size not known (estimate)')
    expect(section).toHaveTextContent('(they disagree)')
    expect(section).toHaveTextContent('None: a failure is not undone automatically')
    expect(section.querySelector('code')?.textContent).toBe(MIGRATION.checksum)
  })

  it('says "not known" for every value the analysis does not have', async () => {
    renderPlan(
      <PlanAnalysisBlock
        overall={{
          compatibility: 'unknown',
          lockSeverity: null,
          destructive: null,
          nontransactional: null,
        }}
        migrations={[
          {
            migrationId: '01JABCDEFGHJKMNPQRSTVWXYZ1',
            name: null,
            compatibility: null,
            lockSeverity: 'unknown',
            statements: [
              {
                index: 0,
                line: null,
                kind: null,
                lock: null,
                compatibility: null,
              },
            ],
            drops: null,
            rewrites: null,
            rollback: null,
            checksum: null,
          },
        ]}
      />,
    )
    const facts = document.querySelectorAll('[data-fact] dd')
    for (const fact of facts) expect(fact).toHaveTextContent('not known')
    const row = statementRow(0)
    for (const cell of [...row.cells].slice(1)) expect(cell).toHaveTextContent('not known')
    expect(screen.queryByText('Nothing')).toBeNull()
    expect(screen.queryByText('No objects dropped')).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('says "not known" when the whole analysis is missing', () => {
    renderPlan(<PlanAnalysisBlock overall={null} migrations={null} />)
    expect(screen.getByText(/The overall analysis is/)).toHaveTextContent('not known')
    expect(screen.getByText(/The analysis per migration is/)).toHaveTextContent('not known')
  })

  it('says "Nothing" only when the server listed no drops', () => {
    renderPlan(<PlanAnalysisBlock overall={null} migrations={[{ ...MIGRATION, drops: [] }]} />)
    const drops = document.querySelector('[data-fact="drops"] dd')
    expect(drops).toHaveTextContent('Nothing')
  })
})
