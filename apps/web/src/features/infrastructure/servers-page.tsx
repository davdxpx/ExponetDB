import type { Server, ServerProvider } from '@exponetdb/sdk/operations'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { ObservedTime, TierChip, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, Fragment, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { ListView } from '../access/list-view.tsx'
import { usePlanRequest } from './actions.ts'
import { serversQuery } from './keys.ts'
import { serverPath } from './model.ts'
import { InfraPage, InfraSection, ObjectLink } from './parts.tsx'
import { isProvider, PROVIDER_GROUPS, ProviderName } from './provider.tsx'
import { RetiredBadge } from './retirement.tsx'

const DEFAULT_PROVIDER: ServerProvider = 'unknown'

/**
 * `/infrastructure/servers` (information-architecture.md §2.1): the servers
 * of the registry (`GET /servers`, `nodes.read`) with what their agent last
 * reported, and "Register server", which asks for the plan
 * `registry.server.create` (`POST /servers`, `registry.manage`) and opens its
 * review page. A server record holds no address; endpoint addresses live on
 * a cluster and only `registry.manage` holders read them.
 */
export function ServersPage(): ReactNode {
  const { client } = useApi()
  const list = useQuery(serversQuery(client))
  return (
    <InfraPage title={t('infra.servers.title')} description={t('infra.servers.description')}>
      <InfraSection id="servers" title={t('infra.servers.list.title')}>
        <ListView
          readable={toReadable(list, {
            missing: (value) =>
              value.nextCursor === null ? undefined : [t('infra.list.more', { count: 200 })],
          })}
          error={list.error}
          what={t('infra.servers.what')}
          permission="nodes.read"
          isEmpty={(value) => value.items.length === 0}
          emptyTitle={t('infra.servers.empty.title')}
          emptyDescription={t('infra.servers.empty.description')}
          onRetry={() => void list.refetch()}
          busy={list.isFetching}
        >
          {(value) => (value.items.length === 0 ? null : <ServerTable servers={value.items} />)}
        </ListView>
      </InfraSection>
      <InfraSection
        id="server-register"
        title={t('infra.servers.register.title')}
        description={t('infra.servers.register.description')}
      >
        <RegisterServerForm />
      </InfraSection>
    </InfraPage>
  )
}

export function ServerFacts({ server }: { readonly server: Server }): ReactNode {
  const facts = server.observedFacts
  if (facts === null) return <span>{t('infra.servers.facts.none')}</span>
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      <span>
        <UntrustedName name={facts.os} label={t('infra.servers.facts.os')} />
        {' · '}
        <UntrustedName name={facts.kernel} mono label={t('infra.servers.facts.kernel')} />
      </span>
      <span>
        {t('infra.servers.facts.size', {
          cpus: facts.cpus,
          memory: (facts.memoryBytes / 1024 ** 3).toFixed(1),
        })}
      </span>
      <span className="text-foreground-light">
        {t('infra.servers.facts.reported')} <ObservedTime observedAt={facts.reportedAt} withDate />
      </span>
    </span>
  )
}

function ServerTable({ servers }: { readonly servers: readonly Server[] }): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('infra.servers.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('infra.column.name')}</TableHead>
          <TableHead scope="col">{t('infra.column.id')}</TableHead>
          <TableHead scope="col">{t('infra.servers.column.provider')}</TableHead>
          <TableHead scope="col">{t('infra.servers.column.location')}</TableHead>
          <TableHead scope="col">{t('infra.column.tier')}</TableHead>
          <TableHead scope="col">{t('infra.servers.column.facts')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {servers.map((server) => (
          <TableRow key={server.id} data-server={server.id}>
            <TableCell>
              <span className="inline-flex flex-wrap items-center gap-2">
                <UntrustedName name={server.displayName} label={t('infra.column.name')} />
                {server.state === 'retired' ? <RetiredBadge /> : null}
              </span>
            </TableCell>
            <TableCell>
              <ObjectLink
                href={serverPath(server.id)}
                text={server.id}
                label={t('infra.column.id')}
              />
            </TableCell>
            <TableCell>
              <ProviderName provider={server.provider} />
            </TableCell>
            <TableCell>
              {server.location === null ? (
                t('infra.value.none')
              ) : (
                <UntrustedName name={server.location} label={t('infra.servers.column.location')} />
              )}
            </TableCell>
            <TableCell>
              {server.derivedTier === null ? (
                t('infra.tier.noneDerived')
              ) : (
                <TierChip tier={server.derivedTier} />
              )}
            </TableCell>
            <TableCell>
              <ServerFacts server={server} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Text a label of the registry accepts: 1 to `max` characters, no control characters. */
function labelOk(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value)
}

function RegisterServerForm(): ReactNode {
  const request = usePlanRequest()
  const nameId = useId()
  const providerId = useId()
  const locationId = useId()
  const refId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState(false)
  // The design system's Select is a button with a listbox, not a form field: the choice is state.
  const [provider, setProvider] = useState<string>(DEFAULT_PROVIDER)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const displayName = String(data.get('displayName') ?? '').trim()
    const location = String(data.get('location') ?? '').trim()
    const providerRef = String(data.get('providerRef') ?? '').trim()
    if (!labelOk(displayName, 128)) {
      setAlert(t('infra.servers.register.nameInvalid'))
      return
    }
    if (!isProvider(provider)) {
      setAlert(t('infra.servers.register.providerInvalid'))
      return
    }
    if (
      (location !== '' && !labelOk(location, 64)) ||
      (providerRef !== '' && !labelOk(providerRef, 128))
    ) {
      setAlert(t('infra.servers.register.labelInvalid'))
      return
    }
    setAlert('')
    setBusy(true)
    request((client) =>
      client.operation('planServer', {
        body: {
          displayName,
          provider,
          ...(location === '' ? {} : { location }),
          ...(providerRef === '' ? {} : { providerRef }),
        },
      }),
    )
      .then(
        () => {
          formRef.current?.reset()
          setProvider(DEFAULT_PROVIDER)
        },
        (error: unknown) => setAlert(describeError(error)),
      )
      .finally(() => setBusy(false))
  }

  return (
    <form
      id="server-register-form"
      ref={formRef}
      className="flex max-w-md flex-col gap-3"
      onSubmit={submit}
      noValidate
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={nameId}>{t('infra.servers.register.name')}</Label>
        <Input id={nameId} name="displayName" maxLength={128} autoComplete="off" disabled={busy} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={providerId}>{t('infra.servers.register.provider')}</Label>
        <Select value={provider} onValueChange={setProvider} disabled={busy}>
          <SelectTrigger id={providerId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_GROUPS.map((group, index) => (
              <Fragment key={group.id}>
                {index > 0 && <SelectSeparator />}
                <SelectGroup>
                  <SelectLabel>{t(`infra.servers.providerGroup.${group.id}`)}</SelectLabel>
                  {group.providers.map((p) => (
                    <SelectItem key={p} value={p}>
                      <ProviderName provider={p} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </Fragment>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={locationId}>{t('infra.servers.register.location')}</Label>
        <Input id={locationId} name="location" maxLength={64} autoComplete="off" disabled={busy} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={refId}>{t('infra.servers.register.providerRef')}</Label>
        <Input id={refId} name="providerRef" maxLength={128} autoComplete="off" disabled={busy} />
      </div>
      <p className="alert text-sm text-destructive" role="alert">
        {alert}
      </p>
      <div>
        <Button type="submit" variant="primary" size="small" loading={busy}>
          {t('infra.servers.register.submit')}
        </Button>
      </div>
    </form>
  )
}
