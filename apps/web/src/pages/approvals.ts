import type { ApprovalQueueItem, ApprovalView, OperationView } from '@exponetdb/contracts'
import { call } from '../api.ts'
import { formatTime, h, replace } from '../dom.ts'
import { withReauth } from '../reauth.ts'
import { action, type Shell } from '../shell.ts'

/**
 * Operations waiting for approval (OD-9): the person sees the exact change
 * and its analysis and approves or rejects the plan hash they reviewed.
 * Approving one's own plan needs an explicit acknowledgement; a critical
 * self-approval cools down on the server before the plan can be applied,
 * and the apply then needs a fresh confirmation. An agent never approves:
 * this page is the Web App, and the server checks the client kind.
 */
export async function approvalsPage(ui: Shell): Promise<void> {
  const { items } = await call<{ items: ApprovalQueueItem[] }>('GET', '/api/v1/approvals')
  const focus = /^#operation=(op_[0-9A-HJKMNP-TV-Z]{26})$/.exec(location.hash)?.[1]
  const reload = () => approvalsPage(ui)
  replace(
    ui.content,
    items.length === 0
      ? h('p', { id: 'no-approvals' }, 'Nothing is waiting for your approval.')
      : h(
          'ul',
          { class: 'cards', id: 'approval-list' },
          ...items.map((i) => card(ui, i, i.operationId === focus, reload)),
        ),
  )
}

function card(
  ui: Shell,
  item: ApprovalQueueItem,
  focused: boolean,
  reload: () => Promise<void>,
): HTMLLIElement {
  const acknowledge = h('input', { type: 'checkbox', name: 'acknowledge' })
  const decide = async (decision: 'approve' | 'reject') => {
    const body = {
      planHash: item.planHash,
      ...(item.ownPlan && decision === 'approve' && acknowledge.checked
        ? { acknowledgeSelfApproval: true }
        : {}),
    }
    const result = await withReauth(() =>
      call<ApprovalView>('POST', `/api/v1/approvals/${item.operationId}/${decision}`, body),
    )
    await reload()
    ui.status(
      decision === 'reject'
        ? 'Rejected; the operation is canceled.'
        : result.notBefore > result.decidedAt
          ? `Approved. The plan can be applied from ${formatTime(result.notBefore)}, with a fresh confirmation.`
          : 'Approved.',
    )
  }
  const mine = item.approvals.find((a) => a.decision === 'approved' && a.selfApproval)
  return h(
    'li',
    { class: focused ? 'card focused' : 'card', 'data-operation': item.operationId },
    h('h2', {}, item.kind, h('span', { class: `badge class-${item.class}` }, item.class)),
    h(
      'dl',
      {},
      h('dt', {}, 'Requested'),
      h('dd', {}, `${formatTime(item.requestedAt)} through ${item.actorClient}`),
      h('dt', {}, 'Plan hash'),
      h('dd', {}, h('code', { class: 'hash' }, item.planHash)),
      h('dt', {}, 'Approvals'),
      h(
        'dd',
        {},
        `${item.approvals.filter((a) => a.decision === 'approved').length} of ${item.required}`,
      ),
    ),
    item.change === undefined
      ? h('p', { class: 'hint' }, 'The change content of this kind is shown from its own wave.')
      : h(
          'details',
          { open: true },
          h('summary', {}, 'Change and analysis'),
          h('pre', { class: 'change' }, JSON.stringify(item.change, null, 2)),
        ),
    item.ownPlan
      ? h(
          'label',
          { class: 'check' },
          acknowledge,
          h(
            'span',
            {},
            'This is my own plan. I approve it myself and know this is recorded prominently.',
          ),
        )
      : null,
    mine === undefined
      ? null
      : h(
          'p',
          { class: 'hint' },
          `You approved this plan; it can be applied from ${formatTime(mine.notBefore)}.`,
        ),
    h(
      'div',
      { class: 'row' },
      action('Approve', ui, () => decide('approve'), { class: 'primary' }),
      action('Reject', ui, () => decide('reject')),
      action('Apply', ui, async () => {
        const operation = await withReauth(() =>
          call<OperationView>('POST', `/api/v1/plans/${item.planId}/apply`),
        )
        await reload()
        ui.status(`Operation ${operation.id} is ${operation.state.replaceAll('_', ' ')}.`)
      }),
    ),
  )
}
