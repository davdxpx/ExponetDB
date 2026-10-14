import type { SchemaObject, SchemaObjectRef } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  Admonition,
  KeyValueList,
  ReadableView,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { type SchemaRead, useSchemaObject } from './queries.ts'
import {
  formatBytes,
  invalidIndexes,
  rlsWithoutPolicy,
  securityDefinerWithoutSearchPath,
  unvalidatedConstraints,
} from './schema-model.ts'

const HEADING = 4
/** Longest definition, default or expression a table cell shows before "Show all". */
const CELL_CODE_POINTS = 200
/** Longest function body or view definition shown before "Show all". */
const DEFINITION_CODE_POINTS = 4000
const DEFINITION_LINES = 40

/**
 * The detail of one object: structure from the canonical schema document
 * and, for functions, views and triggers, the definition text. Everything
 * that came from the catalog (names, defaults, expressions, definitions,
 * comments) is shown through `UntrustedName` and `UntrustedText` with limits;
 * the hints above the facts are raised from structured fields and from the
 * header of a function definition only.
 */
export function ObjectDetail(props: {
  readonly path: string
  readonly object: SchemaObjectRef
}): ReactNode {
  const read = useSchemaObject(props.path, props.object)
  return <ObjectDetailView read={read} />
}

export function ObjectDetailView(props: { readonly read: SchemaRead<SchemaObject> }): ReactNode {
  const { read } = props
  return (
    <ReadableView
      readable={read.readable}
      what={nounPhrase('schema.object.what')}
      onRetry={read.refetch}
      onRefresh={read.refetch}
      busy={read.fetching}
      headingLevel={HEADING}
      ready={(value) => <ObjectBody object={value} />}
    />
  )
}

function Hints({ object }: { readonly object: SchemaObject }): ReactNode {
  const hints: ReactNode[] = []
  if (
    (object.ref.kind === 'function' || object.ref.kind === 'procedure') &&
    securityDefinerWithoutSearchPath(object.definition)
  ) {
    hints.push(
      <Admonition key="definer" type="warning" data-hint="security-definer">
        <p>{t('schema.hint.securityDefiner')}</p>
      </Admonition>,
    )
  }
  if (rlsWithoutPolicy(object)) {
    hints.push(
      <Admonition key="rls" type="warning" data-hint="rls-no-policy">
        <p>{t('schema.hint.rlsNoPolicy')}</p>
      </Admonition>,
    )
  }
  const invalid = invalidIndexes(object)
  if (invalid.length > 0) {
    hints.push(
      <Admonition key="invalid" type="warning" data-hint="invalid-index">
        <p>{t('schema.hint.invalidIndex', { count: invalid.length })}</p>
      </Admonition>,
    )
  }
  const unvalidated = unvalidatedConstraints(object)
  if (unvalidated.length > 0) {
    hints.push(
      <Admonition key="unvalidated" type="warning" data-hint="unvalidated-constraint">
        <p>{t('schema.hint.unvalidated', { count: unvalidated.length })}</p>
      </Admonition>,
    )
  }
  if (hints.length === 0) return null
  return <div className="flex flex-col gap-2">{hints}</div>
}

function ObjectBody({ object }: { readonly object: SchemaObject }): ReactNode {
  return (
    <div className="flex flex-col gap-4" data-slot="object-detail" data-kind={object.ref.kind}>
      <Hints object={object} />
      <KeyValueList
        items={[
          {
            id: 'kind',
            label: t('schema.object.kind'),
            value: <UntrustedName name={object.ref.kind} mono label={t('schema.object.kind')} />,
          },
          {
            id: 'name',
            label: t('schema.object.name'),
            value: <UntrustedName name={object.ref.name} label={t('schema.object.name')} />,
          },
          ...(object.ref.parent === null
            ? []
            : [
                {
                  id: 'parent',
                  label: t('schema.object.parent'),
                  value: (
                    <UntrustedName name={object.ref.parent} label={t('schema.object.parent')} />
                  ),
                },
              ]),
          {
            id: 'owner',
            label: t('schema.object.owner'),
            value: <UntrustedName name={object.owner} label={t('schema.object.owner')} />,
          },
          {
            id: 'size',
            label: t('schema.object.size'),
            value:
              object.sizeBytes === null
                ? t('schema.object.sizeNone')
                : formatBytes(object.sizeBytes),
          },
          ...(object.rowLevelSecurity === null
            ? []
            : [
                {
                  id: 'rls',
                  label: t('schema.object.rls'),
                  value: t(
                    object.rowLevelSecurity.enabled
                      ? object.rowLevelSecurity.forced
                        ? 'schema.object.rls.forced'
                        : 'schema.object.rls.enabled'
                      : 'schema.object.rls.off',
                  ),
                },
              ]),
        ]}
      />
      {object.comment === null ? null : (
        <div>
          <h4 className="text-sm font-medium">{t('schema.object.comment')}</h4>
          <UntrustedText
            text={object.comment}
            maxCodePoints={1000}
            maxLines={8}
            label={t('schema.object.comment')}
          />
        </div>
      )}
      <Columns object={object} />
      <Constraints object={object} />
      <Indexes object={object} />
      <Policies object={object} />
      <Grants object={object} />
      <Definition object={object} />
      <Gaps object={object} />
    </div>
  )
}

function Code({ text, label }: { readonly text: string; readonly label: string }): ReactNode {
  return (
    <UntrustedText
      text={text}
      mono
      maxCodePoints={CELL_CODE_POINTS}
      maxLines={4}
      label={label}
      className="text-xs"
    />
  )
}

function Columns({ object }: { readonly object: SchemaObject }): ReactNode {
  if (object.columns === null) return null
  if (object.columns.length === 0) {
    return <p className="text-sm">{t('schema.columns.none')}</p>
  }
  return (
    <Table>
      <TableCaption className="sr-only">{t('schema.columns.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('schema.columns.name')}</TableHead>
          <TableHead scope="col">{t('schema.columns.type')}</TableHead>
          <TableHead scope="col">{t('schema.columns.nullable')}</TableHead>
          <TableHead scope="col">{t('schema.columns.default')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {object.columns.map((column) => (
          <TableRow key={column.name}>
            <TableCell>
              <UntrustedName name={column.name} mono label={t('schema.columns.name')} />
            </TableCell>
            <TableCell>
              <UntrustedName name={column.type} mono label={t('schema.columns.type')} />
            </TableCell>
            <TableCell>{column.nullable ? t('schema.yes') : t('schema.no')}</TableCell>
            <TableCell>
              {column.default === null && column.generated === null && column.identity === null ? (
                t('schema.none')
              ) : (
                <div className="flex flex-col gap-1">
                  {column.default === null ? null : (
                    <Code text={column.default} label={t('schema.columns.default')} />
                  )}
                  {column.generated === null ? null : (
                    <span>
                      {t('schema.columns.generated')}{' '}
                      <Code text={column.generated} label={t('schema.columns.generated')} />
                    </span>
                  )}
                  {column.identity === null ? null : (
                    <span>{t('schema.columns.identity', { kind: column.identity })}</span>
                  )}
                </div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Constraints({ object }: { readonly object: SchemaObject }): ReactNode {
  if (object.constraints === null) return null
  if (object.constraints.length === 0) {
    return <p className="text-sm">{t('schema.constraints.none')}</p>
  }
  return (
    <Table>
      <TableCaption className="sr-only">{t('schema.constraints.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('schema.constraints.name')}</TableHead>
          <TableHead scope="col">{t('schema.constraints.type')}</TableHead>
          <TableHead scope="col">{t('schema.constraints.definition')}</TableHead>
          <TableHead scope="col">{t('schema.constraints.validated')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {object.constraints.map((constraint) => (
          <TableRow key={constraint.name}>
            <TableCell>
              <UntrustedName name={constraint.name} mono label={t('schema.constraints.name')} />
            </TableCell>
            <TableCell>{constraint.type}</TableCell>
            <TableCell>
              <Code text={constraint.definition} label={t('schema.constraints.definition')} />
            </TableCell>
            <TableCell>
              {constraint.validated ? t('schema.yes') : t('schema.constraints.notValidated')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Indexes({ object }: { readonly object: SchemaObject }): ReactNode {
  if (object.indexes === null) return null
  if (object.indexes.length === 0) return <p className="text-sm">{t('schema.indexes.none')}</p>
  return (
    <div className="flex flex-col gap-1">
      <Table>
        <TableCaption className="sr-only">{t('schema.indexes.caption')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('schema.indexes.name')}</TableHead>
            <TableHead scope="col">{t('schema.indexes.unique')}</TableHead>
            <TableHead scope="col">{t('schema.indexes.valid')}</TableHead>
            <TableHead scope="col">{t('schema.indexes.definition')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {object.indexes.map((index) => (
            <TableRow key={index.name} data-valid={index.valid}>
              <TableCell>
                <UntrustedName name={index.name} mono label={t('schema.indexes.name')} />
              </TableCell>
              <TableCell>{index.unique ? t('schema.yes') : t('schema.no')}</TableCell>
              <TableCell>{index.valid ? t('schema.yes') : t('schema.indexes.invalid')}</TableCell>
              <TableCell>
                <Code text={index.definition} label={t('schema.indexes.definition')} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-foreground-light">{t('schema.indexes.usageNote')}</p>
    </div>
  )
}

function Policies({ object }: { readonly object: SchemaObject }): ReactNode {
  if (object.policies === null) return null
  if (object.policies.length === 0) return <p className="text-sm">{t('schema.policies.none')}</p>
  return (
    <Table>
      <TableCaption className="sr-only">{t('schema.policies.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('schema.policies.name')}</TableHead>
          <TableHead scope="col">{t('schema.policies.command')}</TableHead>
          <TableHead scope="col">{t('schema.policies.kind')}</TableHead>
          <TableHead scope="col">{t('schema.policies.roles')}</TableHead>
          <TableHead scope="col">{t('schema.policies.expressions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {object.policies.map((policy) => (
          <TableRow key={policy.name}>
            <TableCell>
              <UntrustedName name={policy.name} mono label={t('schema.policies.name')} />
            </TableCell>
            <TableCell>{policy.command}</TableCell>
            <TableCell>
              {policy.permissive
                ? t('schema.policies.permissive')
                : t('schema.policies.restrictive')}
            </TableCell>
            <TableCell>
              {policy.roles.map((role) => (
                <UntrustedName key={role} name={role} mono label={t('schema.policies.roles')} />
              ))}
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                {policy.using === null ? null : (
                  <span>
                    {t('schema.policies.using')}{' '}
                    <Code text={policy.using} label={t('schema.policies.using')} />
                  </span>
                )}
                {policy.withCheck === null ? null : (
                  <span>
                    {t('schema.policies.withCheck')}{' '}
                    <Code text={policy.withCheck} label={t('schema.policies.withCheck')} />
                  </span>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Grants({ object }: { readonly object: SchemaObject }): ReactNode {
  if (object.grants === null) return null
  if (object.grants.length === 0) return <p className="text-sm">{t('schema.grants.none')}</p>
  return (
    <Table>
      <TableCaption className="sr-only">{t('schema.grants.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('schema.grants.grantee')}</TableHead>
          <TableHead scope="col">{t('schema.grants.privileges')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {object.grants.map((grant) => (
          <TableRow key={grant.grantee}>
            <TableCell>
              <UntrustedName name={grant.grantee} mono label={t('schema.grants.grantee')} />
            </TableCell>
            <TableCell>
              {grant.privileges.map((privilege) => (
                <UntrustedName
                  key={privilege}
                  name={privilege}
                  mono
                  label={t('schema.grants.privileges')}
                />
              ))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Definition({ object }: { readonly object: SchemaObject }): ReactNode {
  if (object.definition === null) return null
  return (
    <div data-slot="definition">
      <h4 className="text-sm font-medium">{t('schema.definition.title')}</h4>
      <p className="text-xs text-foreground-light">{t('schema.definition.note')}</p>
      <UntrustedText
        text={object.definition}
        mono
        maxCodePoints={DEFINITION_CODE_POINTS}
        maxLines={DEFINITION_LINES}
        label={t('schema.definition.title')}
        className="text-xs"
      />
    </div>
  )
}

/** What the read does not give, said once: nothing is invented to fill it. */
function Gaps({ object }: { readonly object: SchemaObject }): ReactNode {
  if (object.ref.kind !== 'trigger') return null
  return <p className="text-xs text-foreground-light">{t('schema.triggers.modeNote')}</p>
}
