import type { AccessRole, CredentialView } from '@exponetdb/sdk/operations'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exponetdb/ui'
import { formatUtc, KeyValueList } from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { InterstitialLayout } from '../../layouts/interstitial-layout.tsx'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { credentialTarget } from '../../lib/navigation/links.ts'
import { useFragmentBinding } from '../approvals/fragment-binding.ts'
import {
  ACCESS_ROLES,
  credentialKeys,
  credentialListQuery,
  isAccessRole,
  latestOf,
} from './keys.ts'

/**
 * The password of one of ExponetDB's roles on an external cluster
 * (`/credentials#cluster=cls_…[&role=…]`, credentials-and-roles.md §5): the
 * person set the password on the cluster (psql `\password`, or a SCRAM
 * verifier) and enters the same password here once. Write-only: the page
 * never shows a password, keeps it out of React state and the query cache,
 * empties both fields before the request is sent, checks the two match and
 * have at least 16 characters (nothing is sent otherwise), and sends it
 * through `withReauth` (a fresh passkey or authenticator proof). The CLI
 * (`exponetdb cluster credential submit`) opens the page and watches the
 * state. Another fragment reloads the page.
 */
export const MIN_PASSWORD_LENGTH = 16
export const MAX_PASSWORD_LENGTH = 256

export function CredentialsPage(): ReactNode {
  const fragment = useFragmentBinding()
  const [target] = useState(() => credentialTarget(fragment))
  if (target === undefined) {
    return (
      <InterstitialLayout title={t('credentials.title')}>
        <p id="credentials-missing" className="px-6 pb-6 text-center text-sm">
          {t('credentials.missing')}
        </p>
      </InterstitialLayout>
    )
  }
  return (
    <CredentialForm
      cluster={target.cluster}
      initialRole={isAccessRole(target.role) ? target.role : 'observer'}
    />
  )
}

interface Message {
  readonly kind: 'status' | 'alert'
  readonly text: string
}

function stateLine(credential: CredentialView | undefined, truncated: boolean): string {
  if (credential === undefined) {
    return truncated ? t('credentials.state.notListed') : t('credentials.state.none')
  }
  const at = credential.verifiedAt ?? credential.submittedAt
  const time = formatUtc(at) ?? at
  if (credential.state === 'failed') {
    return credential.failureCode === null
      ? t('credentials.state.failedNoCode', { version: credential.version, time })
      : t('credentials.state.failed', {
          version: credential.version,
          code: credential.failureCode,
          time,
        })
  }
  return t('credentials.state.version', {
    version: credential.version,
    state: credential.state,
    time,
  })
}

function CredentialForm({
  cluster,
  initialRole,
}: {
  readonly cluster: string
  readonly initialRole: AccessRole
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const list = useQuery(credentialListQuery(client, cluster))
  const [role, setRole] = useState<AccessRole>(initialRole)
  const [mine, setMine] = useState<readonly CredentialView[]>([])
  const [message, setMessage] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  const hintId = useId()

  const latest = latestOf([...(list.data?.items ?? []), ...mine], role)
  const state = list.isError
    ? t('credentials.state.readFailed', { reason: describeError(list.error) })
    : list.data === undefined && latest === undefined
      ? t('credentials.state.reading')
      : stateLine(latest, list.data?.truncated === true)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (inFlight.current) return
    const value = passwordRef.current?.value ?? ''
    const repeated = confirmRef.current?.value ?? ''
    // Both fields are emptied before anything else happens, so nothing is left in them.
    if (passwordRef.current !== null) passwordRef.current.value = ''
    if (confirmRef.current !== null) confirmRef.current.value = ''
    if (value !== repeated) {
      setMessage({ kind: 'alert', text: t('credentials.mismatch') })
      return
    }
    if (value.length < MIN_PASSWORD_LENGTH) {
      setMessage({ kind: 'alert', text: t('credentials.short') })
      return
    }
    const forRole = role
    inFlight.current = true
    setBusy(true)
    setMessage(null)
    withReauth(client, confirmIdentity, () =>
      client.operation('submitClusterCredential', {
        params: { clusterId: cluster, role: forRole },
        body: { password: value },
      }),
    )
      .then(
        (submitted) => {
          setMine((earlier) => [...earlier, submitted])
          setMessage({
            kind: 'status',
            text: t('credentials.done', { version: submitted.version, role: forRole }),
          })
          void queryClient.invalidateQueries({ queryKey: credentialKeys.list(cluster) })
        },
        (error: unknown) => setMessage({ kind: 'alert', text: describeError(error) }),
      )
      .finally(() => {
        inFlight.current = false
        setBusy(false)
      })
  }

  return (
    <InterstitialLayout
      title={t('credentials.title')}
      description={t('credentials.description')}
      width="wide"
    >
      <section
        id="credentials"
        aria-label={t('credentials.title')}
        className="flex flex-col gap-4 px-6 pb-6"
      >
        <KeyValueList
          layout="stacked"
          items={[
            {
              id: 'cluster',
              label: t('credentials.cluster'),
              value: (
                <code id="credential-cluster" className="font-mono text-xs">
                  {cluster}
                </code>
              ),
            },
          ]}
        />
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-role">{t('credentials.role')}</Label>
            <Select
              value={role}
              onValueChange={(next) => {
                if (isAccessRole(next)) setRole(next)
              }}
              disabled={busy}
            >
              <SelectTrigger id="credential-role" aria-describedby="credential-state">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id="credential-state" className="text-sm text-foreground-light">
              {state}
            </p>
          </div>
          <p id={hintId} className="text-sm text-foreground-light">
            {t('credentials.hint', { min: MIN_PASSWORD_LENGTH })}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-password">{t('credentials.password')}</Label>
            <Input
              id="credential-password"
              ref={passwordRef}
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              spellCheck={false}
              aria-describedby={hintId}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="credential-confirm">{t('credentials.confirm')}</Label>
            <Input
              id="credential-confirm"
              ref={confirmRef}
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              spellCheck={false}
              disabled={busy}
            />
          </div>
          {/* Live regions stay in the page while empty, so a new message is announced. */}
          <div className="flex flex-col">
            <p className="status text-sm" role="status">
              {message?.kind === 'status' ? message.text : ''}
            </p>
            <p className="alert text-sm text-destructive" role="alert">
              {message?.kind === 'alert' ? message.text : ''}
            </p>
          </div>
          <div>
            <Button
              id="credential-submit"
              type="submit"
              variant="primary"
              size="small"
              loading={busy}
            >
              {t('credentials.submit')}
            </Button>
          </div>
        </form>
      </section>
    </InterstitialLayout>
  )
}
