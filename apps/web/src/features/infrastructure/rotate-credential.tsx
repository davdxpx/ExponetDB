import type { AccessRole, Cluster } from '@exponetdb/sdk/operations'
import { Button } from '@exponetdb/ui'
import { ConfirmDialog } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import { useGuardedPlan } from '../targets/plan-request.ts'

/**
 * "Rotate" beside one of ExponetDB's own roles on a cluster a node agent
 * manages: a plan (`planCredentialRotation`, `registry.manage`) in which the
 * worker generates the new password, sets its verifier through the node and
 * logs in with it. Nobody sees the password and the page sends none. Offered
 * for an active agent-managed cluster only (an external cluster's password is
 * submitted by a person on the credentials page); the confirmation names the
 * tier, so a production cluster is recognizable.
 */
export function RotateCredential(props: {
  readonly cluster: Cluster
  readonly role: AccessRole
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const allowed = holds(useMe(), 'registry.manage')
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const [open, setOpen] = useState(false)
  if (!allowed || props.cluster.managementMode !== 'agent' || props.cluster.state !== 'active') {
    return null
  }
  const rotate = async (): Promise<void> => {
    await createPlan(() =>
      client.operation('planCredentialRotation', {
        params: { clusterId: props.cluster.id, role: props.role },
        body: {},
      }),
    )
  }
  return (
    <>
      <Button
        type="button"
        variant="text"
        size="tiny"
        aria-label={t('infra.credential.rotate.label', { role: props.role })}
        onClick={() => setOpen(true)}
      >
        {t('infra.credential.rotate')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('infra.credential.rotate.title')}
        description={t('infra.credential.rotate.body', { role: `exponetdb_${props.role}` })}
        actionLabel={t('infra.credential.rotate.action')}
        tier={props.tier}
        onConfirm={rotate}
      />
    </>
  )
}
