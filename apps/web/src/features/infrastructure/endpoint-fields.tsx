import { Input } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { Field, NativeSelect } from '../access/fields.tsx'
import {
  ENDPOINT_KINDS,
  type EndpointDraft,
  type EndpointKind,
  type EndpointProblems,
  type PoolerMode,
} from './endpoint-model.ts'

const KIND_LABELS: Readonly<Record<EndpointKind, MessageKey>> = {
  private: 'infra.endpoint.kind.private',
  public: 'infra.endpoint.kind.public',
  pooler: 'infra.endpoint.kind.pooler',
  local_socket: 'infra.endpoint.kind.local_socket',
}

/**
 * The fields of one endpoint: kind (and the pooler mode of a pooler), label,
 * host, port and TLS server name. Every field is plain text; the problems are
 * the ones `endpointProblems` found, shown under the field they belong to.
 * `kinds` are the kinds this cluster may take: a local socket is for the host
 * of a cluster a node agent manages, never for an external cluster.
 */
export function EndpointFields(props: {
  readonly id: string
  readonly draft: EndpointDraft
  readonly problems: EndpointProblems
  readonly kinds: readonly EndpointKind[]
  readonly disabled?: boolean
  readonly onChange: (next: EndpointDraft) => void
}): ReactNode {
  const { id, draft, problems, onChange } = props
  const problem = (key: MessageKey | undefined): string | undefined =>
    key === undefined ? undefined : t(key)
  const disabled = props.disabled ?? false
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field id={`${id}-kind`} label={t('infra.endpoint.kind')}>
        <NativeSelect
          id={`${id}-kind`}
          value={draft.kind}
          disabled={disabled}
          options={ENDPOINT_KINDS.filter((kind) => props.kinds.includes(kind)).map((kind) => ({
            value: kind,
            label: t(KIND_LABELS[kind]),
          }))}
          onChange={(event) => {
            const kind = ENDPOINT_KINDS.find((candidate) => candidate === event.target.value)
            if (kind !== undefined) onChange({ ...draft, kind })
          }}
        />
      </Field>
      {draft.kind === 'pooler' ? (
        <Field
          id={`${id}-pooler`}
          label={t('infra.endpoint.poolerMode')}
          error={problem(problems.poolerMode)}
        >
          <NativeSelect
            id={`${id}-pooler`}
            value={draft.poolerMode}
            disabled={disabled}
            aria-invalid={problems.poolerMode !== undefined}
            options={[
              { value: '', label: t('infra.endpoint.poolerMode.choose') },
              { value: 'session', label: t('infra.endpoint.poolerMode.session') },
              { value: 'transaction', label: t('infra.endpoint.poolerMode.transaction') },
            ]}
            onChange={(event) => {
              const mode: PoolerMode | '' =
                event.target.value === 'session' || event.target.value === 'transaction'
                  ? event.target.value
                  : ''
              onChange({ ...draft, poolerMode: mode })
            }}
          />
        </Field>
      ) : null}
      <Field id={`${id}-label`} label={t('infra.endpoint.label')} error={problem(problems.label)}>
        <Input
          id={`${id}-label`}
          autoComplete="off"
          maxLength={64}
          value={draft.label}
          disabled={disabled}
          aria-invalid={problems.label !== undefined}
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
        />
      </Field>
      <Field
        id={`${id}-host`}
        label={t('infra.endpoint.host')}
        description={t('infra.endpoint.host.hint')}
        error={problem(problems.host)}
      >
        <Input
          id={`${id}-host`}
          autoComplete="off"
          spellCheck={false}
          maxLength={253}
          className="font-mono"
          value={draft.host}
          disabled={disabled}
          aria-invalid={problems.host !== undefined}
          aria-describedby={`${id}-host-description`}
          onChange={(event) => onChange({ ...draft, host: event.target.value })}
        />
      </Field>
      <Field id={`${id}-port`} label={t('infra.endpoint.port')} error={problem(problems.port)}>
        <Input
          id={`${id}-port`}
          inputMode="numeric"
          autoComplete="off"
          maxLength={5}
          className="w-28 font-mono"
          value={draft.port}
          disabled={disabled}
          aria-invalid={problems.port !== undefined}
          onChange={(event) => onChange({ ...draft, port: event.target.value })}
        />
      </Field>
      <Field
        id={`${id}-tls`}
        label={t('infra.endpoint.tls')}
        description={t('infra.endpoint.tls.hint')}
        error={problem(problems.tls)}
      >
        <Input
          id={`${id}-tls`}
          autoComplete="off"
          spellCheck={false}
          maxLength={253}
          className="font-mono"
          value={draft.tlsServerName}
          disabled={disabled}
          aria-invalid={problems.tls !== undefined}
          aria-describedby={`${id}-tls-description`}
          onChange={(event) => onChange({ ...draft, tlsServerName: event.target.value })}
        />
      </Field>
    </div>
  )
}
