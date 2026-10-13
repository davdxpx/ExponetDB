import { t } from '../../lib/i18n/i18n.ts'
import { safeReturnTo } from '../../lib/navigation/links.ts'
import { isOperationId, planPath } from '../plans/plan-model.ts'
import type { AuditEvent } from './keys.ts'

/**
 * Links from an audit event into the app, built from the event's typed ids
 * only and kept only when the path is one of the app's allowlisted pages
 * (`safeReturnTo` answers the same path): the plan review page, the
 * operation page, and the migrations ledger of the event's target for a
 * migration or ledger action. Nothing in an event becomes a link otherwise.
 */
export interface EventLinks {
  readonly plan?: string
  readonly operation?: string
  readonly ledger?: string
}

function allowed(path: string | undefined): string | undefined {
  return path !== undefined && safeReturnTo(path) === path ? path : undefined
}

function ledgerPath(event: AuditEvent): string | undefined {
  const path = event.subject.targetPath
  if (path === null) return undefined
  if (!/^(?:migration|ledger)\./.test(event.action)) return undefined
  const parts = path.split('/')
  if (parts.length !== 3) return undefined
  return `/t/${parts.map((part) => encodeURIComponent(part)).join('/')}/migrations`
}

export function eventLinks(event: AuditEvent): EventLinks {
  const plan = allowed(planPath(event.refs.planId))
  const operationId = event.refs.operationId
  const operation = allowed(
    isOperationId(operationId) ? `/changes/operations/${operationId}` : undefined,
  )
  const ledger = allowed(ledgerPath(event))
  return {
    ...(plan === undefined ? {} : { plan }),
    ...(operation === undefined ? {} : { operation }),
    ...(ledger === undefined ? {} : { ledger }),
  }
}

export function outcomeLabel(status: AuditEvent['result']['status']): string {
  switch (status) {
    case 'succeeded':
      return t('audit.outcome.succeeded')
    case 'failed':
      return t('audit.outcome.failed')
    case 'denied':
      return t('audit.outcome.denied')
  }
}

export function phaseLabel(phase: AuditEvent['phase']): string {
  switch (phase) {
    case 'requested':
      return t('audit.phase.requested')
    case 'denied':
      return t('audit.phase.denied')
    case 'accepted':
      return t('audit.phase.accepted')
    case 'completed':
      return t('audit.phase.completed')
    case 'failed':
      return t('audit.phase.failed')
    case 'reconciled':
      return t('audit.phase.reconciled')
  }
}

export function actorKindLabel(kind: AuditEvent['actor']['kind']): string {
  switch (kind) {
    case 'human':
      return t('audit.actor.human')
    case 'service':
      return t('audit.actor.service')
    case 'system':
      return t('audit.actor.system')
  }
}
