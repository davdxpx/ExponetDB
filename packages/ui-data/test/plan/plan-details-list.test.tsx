import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PlanDetailsList } from '../../src/plan/plan-details-list.tsx'
import { axeViolations } from '../support/axe.ts'
import {
  CREATED_AT,
  EXPIRES_AT,
  HASH,
  PLAN_ID,
  PROD_PATH,
  RLO,
  renderPlan,
  ZWSP,
} from './support.tsx'

afterEach(cleanup)

const SERVER = 'srv_01JABCDEFGHJKMNPQRSTVWXYZ0'
const IDENTITY = 'idn_01JABCDEFGHJKMNPQRSTVWXYZ0'

function fact(id: string): Element | null {
  return document.querySelector(`[data-fact="${id}"]`)
}

describe('PlanDetailsList', () => {
  it('lists only the facts that apply to a node plan, and none of them as "not known"', async () => {
    const { container } = renderPlan(
      <PlanDetailsList
        planId={PLAN_ID}
        planHash={HASH}
        kind="node.enroll"
        planClass="high"
        subject={{ serverId: SERVER }}
        tier={null}
        creator={{ kind: 'human', identityId: IDENTITY, via: 'web' }}
        createdAt={CREATED_AT}
        expiresAt={EXPIRES_AT}
        now={CREATED_AT}
      />,
    )
    expect(
      [...container.querySelectorAll('[data-fact]')].map((f) => f.getAttribute('data-fact')),
    ).toEqual([
      'plan-id',
      'plan-hash',
      'kind',
      'class',
      'server',
      'tier',
      'creator',
      'through',
      'created',
      'expires',
    ])
    expect(container.querySelectorAll('[data-not-known]')).toHaveLength(0)
    expect(fact('tier')).toHaveTextContent('None; the page treats the plan as production')
    expect(fact('creator')).toHaveTextContent(IDENTITY)
    expect(fact('through')).toHaveTextContent('Web App')
    expect(container.querySelector('code.full-hash')?.textContent).toBe(HASH)
    expect(screen.getByRole('button', { name: 'Copy plan hash' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy plan ID' })).toBeVisible()
    // The tier is words, never a second production chip.
    expect(container.querySelector('[data-tier]')).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('shows the facts of a migration plan, with "not known" where one applies and is missing', () => {
    const { container } = renderPlan(
      <PlanDetailsList
        planId={PLAN_ID}
        planHash={HASH}
        kind="migration.apply"
        planClass="high"
        subject={{ targetPath: PROD_PATH, targetId: 'tgt_01JABCDEFGHJKMNPQRSTVWXYZ0' }}
        tier="prod"
        classifications={null}
        creator={{ kind: 'human', identityId: IDENTITY, via: 'mcp' }}
        client={{ id: 'cli_01JABCDEFGHJKMNPQRSTVWXYZ0', name: null }}
        createdAt={CREATED_AT}
        expiresAt={EXPIRES_AT}
        operationId="op_01JABCDEFGHJKMNPQRSTVWXYZ0"
        requirements={[{ kind: 'approval', count: 1, permission: 'plans.approve' }]}
        rules={[
          {
            id: 'migration.agent-production',
            severity: 'require',
            result: 'fail',
            message: 'x',
          },
        ]}
        schemaFingerprint={null}
        newestBackup={null}
        now={CREATED_AT}
      />,
    )
    for (const id of ['classifications', 'client-name', 'schema-fingerprint', 'newest-backup']) {
      expect(fact(id)?.querySelector('[data-not-known]'), id).not.toBeNull()
    }
    expect(fact('target')).toHaveTextContent(PROD_PATH)
    expect(fact('tier')).toHaveTextContent('Production')
    expect(fact('rules')).toHaveTextContent('migration.agent-production')
    expect(fact('requirements')).toHaveTextContent('1 approval by a person with plans.approve')
    expect(fact('operation')).toHaveTextContent('op_01JABCDEFGHJKMNPQRSTVWXYZ0')
    expect(container.querySelector('.client-name')).toBeNull()
  })

  it('renders a hostile client name as marked text, not verified', () => {
    const { container } = renderPlan(
      <PlanDetailsList
        planId={PLAN_ID}
        planHash={HASH}
        kind="migration.apply"
        planClass="standard"
        subject={{ targetPath: PROD_PATH }}
        tier="nonprod"
        creator={{ kind: 'human', identityId: IDENTITY, via: 'mcp' }}
        client={{ id: null, name: `Agent${ZWSP} <b>x</b>${RLO}` }}
        createdAt={CREATED_AT}
        expiresAt={EXPIRES_AT}
        rules={[]}
        now={CREATED_AT}
      />,
    )
    const name = container.querySelector('.client-name') as HTMLElement
    expect(name).toHaveTextContent('name not verified')
    expect(name.querySelector('b')).toBeNull()
    expect(name.textContent).not.toContain(RLO)
    expect(fact('rules')).toHaveTextContent('None')
    expect(fact('tier')).toHaveTextContent('Non-production')
  })
})
