import type { Cluster, Node } from '@exponetdb/sdk/operations'
import {
  Button,
  Input,
  Label,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  MarkedCode,
  NotPermittedState,
  ObservedTime,
  ReadableView,
  TypedConfirmDialog,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { usePlanRequest } from './actions.ts'
import { infraKeys, ROLES_INSPECT, rolesObservationQuery } from './keys.ts'
import {
  type AttributeChoice,
  type DesiredRole,
  dangerousGrants,
  emptyRole,
  isConsumerRoleName,
  observedRoles,
  ROLE_ATTRIBUTES,
  type RoleAttribute,
  roleProblem,
  roleSteps,
} from './model.ts'
import { isScramSafePassword, scramSha256Verifier } from './scram.ts'

/**
 * Consumer roles as cluster-wide desired state (credentials-and-roles.md §4):
 *
 * - the roles the node last observed (`postgres.roles.inspect@2`, node
 *   signed, with its time), and "Read roles now" (`node.inspect`), because a
 *   role plan and a verifier are bound to an observation at most 10 minutes
 *   old;
 * - the desired roles and their attributes, sent as one `postgres.roles.apply`
 *   plan (`POST /nodes/{id}/plans`); granting `BYPASSRLS`, `REPLICATION` or
 *   `CREATEROLE` first needs the cluster's name typed;
 * - a role's password set as a SCRAM-SHA-256 verifier computed in this
 *   browser (§4.1): only `{ role, verifier }` is sent, never the password.
 */
const SELECT_CLASS =
  'h-[30px] rounded-md border border-control bg-control px-2 text-xs text-foreground focus-ring'

export function ObservedRoles({
  cluster,
  node,
}: {
  readonly cluster: Cluster
  readonly node: Node
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const observation = useQuery(rolesObservationQuery(client, node.id, cluster.id))
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const inspect = (): void => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    withReauth(client, confirmIdentity, () =>
      client.operation('inspectNode', {
        params: { nodeId: node.id },
        body: { capability: ROLES_INSPECT, clusterId: cluster.id, args: { expectSettings: [] } },
      }),
    )
      .then(
        (operation) => {
          setMessage({
            kind: 'status',
            text: t('infra.roles.inspect.started', { id: operation.id }),
          })
          void queryClient.invalidateQueries({
            queryKey: infraKeys.observations(node.id, ROLES_INSPECT, cluster.id),
          })
        },
        (error: unknown) => setMessage({ kind: 'alert', text: describeError(error) }),
      )
      .finally(() => setBusy(false))
  }
  return (
    <div className="flex flex-col gap-3">
      {observation.isError && classifyFailure(observation.error).kind === 'not_permitted' ? (
        <NotPermittedState
          what={t('infra.roles.observed.what')}
          permission="nodes.read"
          headingLevel={4}
        />
      ) : (
        <ReadableView
          readable={toReadable(observation, { staleAfterMs: 10 * 60_000 })}
          what={t('infra.roles.observed.what')}
          onRetry={() => void observation.refetch()}
          onRefresh={() => void observation.refetch()}
          busy={observation.isFetching}
          headingLevel={4}
          empty={{
            isEmpty: (v) => v.items.length === 0,
            content: (
              <p className="text-sm text-foreground-light">{t('infra.roles.observed.none')}</p>
            ),
          }}
          ready={(v) => {
            const latest = [...v.items].sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
            if (latest === undefined) return null
            const { roles, unreadable } = observedRoles(latest.result)
            return (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-foreground-light">
                  {t('infra.roles.observed.when')}{' '}
                  <ObservedTime observedAt={latest.observedAt} withDate />
                </p>
                {unreadable > 0 ? (
                  <p className="text-sm text-warning-600">
                    {t('infra.roles.observed.unreadable', { count: unreadable })}
                  </p>
                ) : null}
                <Table>
                  <TableCaption className="sr-only">{t('infra.roles.observed.what')}</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t('infra.roles.column.role')}</TableHead>
                      <TableHead scope="col">{t('infra.roles.column.attributes')}</TableHead>
                      <TableHead scope="col">{t('infra.roles.column.password')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {roles.map((role, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the node's rows may repeat a name and never reorder
                      <TableRow key={`${index}:${role.name}`}>
                        <TableCell>
                          <UntrustedName
                            name={role.name}
                            mono
                            label={t('infra.roles.column.role')}
                          />
                        </TableCell>
                        <TableCell className="text-xs">
                          {(
                            [
                              ['login', role.login],
                              ['superuser', role.superuser],
                              ['createrole', role.createrole],
                              ['replication', role.replication],
                              ['bypassrls', role.bypassrls],
                            ] as const
                          )
                            .filter(([, on]) => on)
                            .map(([name]) => name.toUpperCase())
                            .join(', ') || t('infra.value.none')}
                        </TableCell>
                        <TableCell className="text-xs">
                          <UntrustedName
                            name={role.password}
                            label={t('infra.roles.column.password')}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          }}
        />
      )}
      <div className="flex flex-col items-start gap-1">
        <Button type="button" variant="default" size="small" loading={busy} onClick={inspect}>
          {t('infra.roles.inspect.button')}
        </Button>
        <p className="status text-sm" role="status">
          {message?.kind === 'status' ? message.text : ''}
        </p>
        <p className="alert text-sm text-destructive" role="alert">
          {message?.kind === 'alert' ? message.text : ''}
        </p>
      </div>
    </div>
  )
}

const CHOICES: readonly AttributeChoice[] = ['keep', 'grant', 'revoke']

export function DesiredRolesForm({
  cluster,
  node,
  tier,
}: {
  readonly cluster: Cluster
  readonly node: Node
  readonly tier: 'prod' | 'nonprod'
}): ReactNode {
  const request = usePlanRequest()
  const counter = useRef(1)
  const [roles, setRoles] = useState<readonly DesiredRole[]>(() => [emptyRole('role-0')])
  const [alert, setAlert] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const update = (key: string, change: (role: DesiredRole) => DesiredRole): void =>
    setRoles((all) => all.map((role) => (role.key === key ? change(role) : role)))

  const send = (): Promise<unknown> =>
    request((client) =>
      client.operation('planNodeOperation', {
        params: { nodeId: node.id },
        body: {
          clusterId: cluster.id,
          change: { kind: 'postgres.roles.apply', steps: roleSteps(roles) },
        },
      }),
    )

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    const problem = roleProblem(roles)
    if (problem.kind !== 'none') {
      setAlert(t(`infra.roles.problem.${problem.kind}`, { row: problem.index + 1 }))
      return
    }
    setAlert('')
    if (dangerousGrants(roles).length > 0) {
      setConfirming(true)
      return
    }
    setBusy(true)
    send()
      .catch((error: unknown) => setAlert(describeError(error)))
      .finally(() => setBusy(false))
  }

  const grants = dangerousGrants(roles)
  return (
    <form id="roles-form" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <p className="text-sm text-foreground-light">{t('infra.roles.desired.hint')}</p>
      <ul className="flex flex-col gap-3">
        {roles.map((role, index) => (
          <DesiredRoleRow
            key={role.key}
            role={role}
            index={index}
            disabled={busy}
            onChange={(change) => update(role.key, change)}
            onRemove={
              roles.length === 1
                ? undefined
                : () => setRoles((all) => all.filter((r) => r.key !== role.key))
            }
          />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="default"
          size="small"
          disabled={busy || roles.length >= 64}
          onClick={() => {
            const key = `role-${counter.current}`
            counter.current += 1
            setRoles((all) => [...all, emptyRole(key)])
          }}
        >
          {t('infra.roles.desired.add')}
        </Button>
        <Button type="submit" variant="primary" size="small" loading={busy}>
          {t('infra.roles.desired.submit')}
        </Button>
      </div>
      <p className="alert text-sm text-destructive" role="alert">
        {alert}
      </p>
      <TypedConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('infra.roles.dangerous.title')}
        description={t('infra.roles.dangerous.description')}
        actionLabel={t('infra.roles.dangerous.action')}
        tier={tier}
        expectedText={cluster.displayName}
        resetKey={JSON.stringify(grants)}
        onConfirm={send}
      >
        <ul className="flex flex-col gap-1 text-sm" aria-label={t('infra.roles.dangerous.list')}>
          {grants.map((grant) => (
            <li key={`${grant.role}:${grant.attribute}`}>
              {t('infra.roles.dangerous.grant', { attribute: grant.attribute.toUpperCase() })}{' '}
              <MarkedCode text={grant.role} />
            </li>
          ))}
        </ul>
      </TypedConfirmDialog>
    </form>
  )
}

function DesiredRoleRow({
  role,
  index,
  disabled,
  onChange,
  onRemove,
}: {
  readonly role: DesiredRole
  readonly index: number
  readonly disabled: boolean
  readonly onChange: (change: (role: DesiredRole) => DesiredRole) => void
  readonly onRemove: (() => void) | undefined
}): ReactNode {
  const base = useId()
  return (
    <li
      data-role-row={index + 1}
      className="flex flex-col gap-2 rounded-md border border-default p-3"
      aria-label={t('infra.roles.desired.row', { row: index + 1 })}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${base}-name`}>{t('infra.roles.desired.name')}</Label>
          <Input
            id={`${base}-name`}
            name={`role-${index}-name`}
            value={role.name}
            maxLength={63}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => {
              const name = event.currentTarget.value
              onChange((r) => ({ ...r, name }))
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${base}-op`}>{t('infra.roles.desired.op')}</Label>
          <select
            id={`${base}-op`}
            className={SELECT_CLASS}
            value={role.op}
            disabled={disabled}
            onChange={(event) => {
              const op = event.currentTarget.value === 'alter_role' ? 'alter_role' : 'create_role'
              onChange((r) => ({ ...r, op }))
            }}
          >
            <option value="create_role">{t('infra.roles.op.create_role')}</option>
            <option value="alter_role">{t('infra.roles.op.alter_role')}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${base}-limit`}>{t('infra.roles.desired.limit')}</Label>
          <Input
            id={`${base}-limit`}
            value={role.connectionLimit}
            inputMode="numeric"
            autoComplete="off"
            className="w-28"
            disabled={disabled}
            onChange={(event) => {
              const connectionLimit = event.currentTarget.value
              onChange((r) => ({ ...r, connectionLimit }))
            }}
          />
        </div>
        {onRemove === undefined ? null : (
          <Button type="button" variant="text" size="tiny" disabled={disabled} onClick={onRemove}>
            {t('infra.roles.desired.remove')}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        {ROLE_ATTRIBUTES.map((attribute: RoleAttribute) => (
          <div key={attribute} className="flex flex-col gap-1">
            <Label htmlFor={`${base}-${attribute}`} className="font-mono text-xs">
              {attribute.toUpperCase()}
            </Label>
            <select
              id={`${base}-${attribute}`}
              data-attribute={attribute}
              className={SELECT_CLASS}
              value={role.attributes[attribute]}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value
                const next: AttributeChoice =
                  value === 'grant' ? 'grant' : value === 'revoke' ? 'revoke' : 'keep'
                onChange((r) => ({ ...r, attributes: { ...r.attributes, [attribute]: next } }))
              }}
            >
              {CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {t(`infra.roles.choice.${choice}`)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </li>
  )
}

export const MIN_ROLE_PASSWORD_LENGTH = 16
export const MAX_ROLE_PASSWORD_LENGTH = 256

/**
 * "Set a role's password": the person types the password twice; the page
 * empties both fields first, checks they match, have at least 16 printable
 * ASCII characters, derives the SCRAM-SHA-256 verifier with WebCrypto (4096
 * iterations, a 16-byte random salt) and sends `{ role, verifier }` only
 * (`POST /clusters/{id}/role-verifiers`, a fresh proof), then opens the
 * plan's review page. The password is never in React state, the query
 * cache, a request, an error or a log.
 */
export function RoleVerifierForm({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const request = usePlanRequest()
  const roleId = useId()
  const passwordId = useId()
  const confirmId = useId()
  const hintId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (inFlight.current) return
    const role = String(new FormData(event.currentTarget).get('role') ?? '').trim()
    let password = passwordRef.current?.value ?? ''
    const repeated = confirmRef.current?.value ?? ''
    // Both fields are emptied before anything else happens, so nothing is left in them.
    if (passwordRef.current !== null) passwordRef.current.value = ''
    if (confirmRef.current !== null) confirmRef.current.value = ''
    if (!isConsumerRoleName(role)) {
      setAlert(t('infra.verifier.roleInvalid'))
      return
    }
    if (password !== repeated) {
      setAlert(t('infra.verifier.mismatch'))
      return
    }
    if (password.length < MIN_ROLE_PASSWORD_LENGTH || password.length > MAX_ROLE_PASSWORD_LENGTH) {
      setAlert(t('infra.verifier.short', { min: MIN_ROLE_PASSWORD_LENGTH }))
      return
    }
    if (!isScramSafePassword(password)) {
      setAlert(t('infra.verifier.ascii'))
      return
    }
    inFlight.current = true
    setBusy(true)
    setAlert('')
    const derived = scramSha256Verifier(password)
    password = ''
    derived
      .then((verifier) =>
        request((client) =>
          client.operation('submitRoleVerifier', {
            params: { clusterId: cluster.id },
            body: { role, verifier },
          }),
        ),
      )
      .catch((error: unknown) =>
        setAlert(error instanceof TypeError ? t('infra.verifier.failed') : describeError(error)),
      )
      .finally(() => {
        inFlight.current = false
        setBusy(false)
      })
  }

  return (
    <form id="verifier-form" className="flex max-w-md flex-col gap-3" onSubmit={submit} noValidate>
      <p id={hintId} className="text-sm text-foreground-light">
        {t('infra.verifier.hint', { min: MIN_ROLE_PASSWORD_LENGTH })}
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={roleId}>{t('infra.verifier.role')}</Label>
        <Input
          id={roleId}
          name="role"
          maxLength={63}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={passwordId}>{t('infra.verifier.password')}</Label>
        <Input
          id={passwordId}
          ref={passwordRef}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_ROLE_PASSWORD_LENGTH}
          maxLength={MAX_ROLE_PASSWORD_LENGTH}
          spellCheck={false}
          aria-describedby={hintId}
          disabled={busy}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={confirmId}>{t('infra.verifier.confirm')}</Label>
        <Input
          id={confirmId}
          ref={confirmRef}
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={MIN_ROLE_PASSWORD_LENGTH}
          maxLength={MAX_ROLE_PASSWORD_LENGTH}
          spellCheck={false}
          disabled={busy}
        />
      </div>
      <p className="alert text-sm text-destructive" role="alert">
        {alert}
      </p>
      <div>
        <Button id="verifier-submit" type="submit" variant="primary" size="small" loading={busy}>
          {t('infra.verifier.submit')}
        </Button>
      </div>
    </form>
  )
}
