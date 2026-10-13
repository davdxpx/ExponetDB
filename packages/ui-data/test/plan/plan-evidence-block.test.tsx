import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PlanEvidenceBlock } from '../../src/plan/plan-evidence-block.tsx'
import { axeViolations } from '../support/axe.ts'
import { renderPlan } from './support.tsx'

afterEach(cleanup)

const FINGERPRINT = `fp1:${'9a'.repeat(32)}`

function fact(id: string): HTMLElement {
  const value = document.querySelector(`[data-fact="${id}"] dd`)
  if (!(value instanceof HTMLElement)) throw new Error(`no fact ${id}`)
  return value
}

describe('PlanEvidenceBlock', () => {
  it('shows staging evidence, the bound fingerprint in full and the newest backup as not known', async () => {
    renderPlan(
      <PlanEvidenceBlock
        evidence="present"
        evidenceEnvironment="shop/platform/staging"
        items={[
          {
            migrationId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
            status: 'present',
            verifiedAt: '2026-10-13T12:00:00.000Z',
          },
        ]}
        schemaFingerprint={FINGERPRINT}
        newestBackup={null}
        now="2026-10-13T14:00:00.000Z"
      />,
    )
    expect(fact('evidence')).toHaveTextContent(
      'Applied and verified with the same checksum on the evidence environment',
    )
    expect(fact('evidence-environment')).toHaveTextContent('shop/platform/staging')
    expect(fact('schema-fingerprint').querySelector('code')?.textContent).toBe(FINGERPRINT)
    expect(fact('schema-fingerprint')).toHaveTextContent(
      'Any schema change before the apply makes the plan stale.',
    )
    expect(fact('newest-backup')).toHaveTextContent('not known')
    expect(screen.getByRole('list', { name: 'Evidence per migration' })).toHaveTextContent(
      'verified 2026-10-13 12:00 UTC (2 h ago)',
    )
    expect(await axeViolations()).toEqual([])
  })

  it.each([
    ['missing', 'Missing: not applied and verified with the same checksum'],
    ['unverified', 'Applied on the evidence environment, but not verified there'],
    ['other_verify_digest', 'with a different verify.sql'],
    ['unreachable', 'The evidence environment could not be read'],
    ['not_required', 'Not required for this target'],
  ])('names the evidence state %s', (evidence, text) => {
    renderPlan(
      <PlanEvidenceBlock evidence={evidence} schemaFingerprint={FINGERPRINT} newestBackup={null} />,
    )
    expect(fact('evidence')).toHaveTextContent(text)
  })

  it('names a break-glass grant the plan was made under', () => {
    renderPlan(
      <PlanEvidenceBlock
        evidence="missing"
        breakGlass={{
          grantId: 'bgg_01JABCDEFGHJKMNPQRSTVWXYZ0',
          rules: ['migrations.staging-evidence', 'migrations.lineage'],
        }}
        schemaFingerprint={FINGERPRINT}
        newestBackup={null}
      />,
    )
    const note = screen.getByText('Made under break-glass.').closest('[role="note"]')
    expect(note).toHaveTextContent('bgg_01JABCDEFGHJKMNPQRSTVWXYZ0')
    expect(note).toHaveTextContent('migrations.staging-evidence,')
    expect(note).toHaveTextContent('migrations.lineage')
  })

  it('says "not known" for missing evidence, an unknown state and a missing fingerprint', async () => {
    const { rerender } = renderPlan(
      <PlanEvidenceBlock
        evidence={null}
        evidenceEnvironment={null}
        schemaFingerprint={null}
        newestBackup={null}
      />,
    )
    expect(fact('evidence')).toHaveTextContent('not known')
    expect(fact('evidence-environment')).toHaveTextContent('not known')
    expect(fact('schema-fingerprint')).toHaveTextContent('not known')
    expect(await axeViolations()).toEqual([])
    rerender(
      <PlanEvidenceBlock evidence="unknown" schemaFingerprint="unknown" newestBackup={null} />,
    )
    expect(fact('evidence')).toHaveTextContent('not known')
    expect(fact('evidence')).not.toHaveTextContent('Applied')
    expect(fact('schema-fingerprint')).toHaveTextContent('not known')
  })

  it('shows a newest backup once the server reports one', () => {
    renderPlan(
      <PlanEvidenceBlock
        evidence="present"
        schemaFingerprint={FINGERPRINT}
        newestBackup={{ at: '2026-10-13T13:00:00.000Z', verified: null }}
        now="2026-10-13T14:00:00.000Z"
      />,
    )
    expect(fact('newest-backup')).toHaveTextContent('2026-10-13 13:00 UTC (1 h ago)')
    expect(fact('newest-backup')).toHaveTextContent('(restore test not known)')
  })
})
