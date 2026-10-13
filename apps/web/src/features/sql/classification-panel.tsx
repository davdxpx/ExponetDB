import type { SqlClassification } from '@exponetdb/sdk/operations'
import { Button } from '@exponetdb/ui'
import {
  ClassificationBadge,
  FailedReadState,
  LoadingState,
  type ReadFailure,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { lineColumnAt, statementText } from './sql-model.ts'

/**
 * What the server says the text is (sql-execution-security.md §2.5), shown
 * live: per statement its lines, the parser's kind, the classes as badges and
 * whether the read path would admit it; the parse error at its place. A
 * statement without a class says that nothing could be derived, never that
 * it is safe; a classification that failed is a failure, never "safe".
 */
export type ClassificationView =
  | { readonly state: 'idle' }
  | { readonly state: 'too_large' }
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly error: ReadFailure; readonly retry: () => void }
  | { readonly state: 'ready'; readonly text: string; readonly value: SqlClassification }

export function ClassificationPanel(props: {
  readonly view: ClassificationView
  readonly onGoTo: (line: number, column: number) => void
  readonly headingLevel?: 2 | 3
}): ReactNode {
  const Heading = props.headingLevel === 2 ? 'h2' : 'h3'
  return (
    <section
      aria-labelledby="sql-classification-title"
      className="flex flex-col gap-3"
      data-block="sql-classification"
      data-state={props.view.state}
    >
      <Heading id="sql-classification-title" className="text-sm font-medium">
        {t('sql.class.title')}
      </Heading>
      <ClassificationBody view={props.view} onGoTo={props.onGoTo} />
    </section>
  )
}

function ClassificationBody(props: {
  readonly view: ClassificationView
  readonly onGoTo: (line: number, column: number) => void
}): ReactNode {
  const { view } = props
  switch (view.state) {
    case 'idle':
      return <p className="text-sm text-foreground-light">{t('sql.class.idle')}</p>
    case 'too_large':
      return (
        <p className="text-sm text-foreground-light" role="status">
          {t('sql.class.tooLarge')}
        </p>
      )
    case 'loading':
      return <LoadingState what={nounPhrase('sql.class.what')} lines={2} />
    case 'failed':
      return (
        <FailedReadState
          what={nounPhrase('sql.class.what')}
          error={view.error}
          onRetry={view.retry}
          headingLevel={4}
        >
          <p className="text-sm">{t('sql.class.failedNotSafe')}</p>
        </FailedReadState>
      )
    case 'ready':
      return <ClassificationReady text={view.text} value={view.value} onGoTo={props.onGoTo} />
  }
}

function ClassificationReady(props: {
  readonly text: string
  readonly value: SqlClassification
  readonly onGoTo: (line: number, column: number) => void
}): ReactNode {
  const { value, text } = props
  const grammar = t('sql.class.grammar', { major: value.postgresMajor })
  if (value.status === 'empty') {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p>{t('sql.class.empty')}</p>
        <p className="text-foreground-lighter">{grammar}</p>
      </div>
    )
  }
  if (value.status === 'parse_error') {
    const position = value.parseError?.position ?? null
    const at = position === null ? undefined : lineColumnAt(text, position.offset)
    return (
      <div className="flex flex-col gap-2 text-sm" data-parse-error="true">
        <p role="status" className="font-medium">
          {at === undefined
            ? t('sql.class.parseErrorNoPosition', { reason: value.parseError?.reason ?? 'syntax' })
            : t('sql.class.parseError', { line: at.line, column: at.column })}
        </p>
        {at === undefined ? null : (
          <div>
            <Button variant="outline" size="tiny" onClick={() => props.onGoTo(at.line, at.column)}>
              {t('sql.class.goToError')}
            </Button>
          </div>
        )}
        <p className="text-foreground-light">{t('sql.class.parseErrorNotSafe')}</p>
        <p className="text-foreground-lighter">{grammar}</p>
      </div>
    )
  }
  const refusal = value.readOnlyPath.refusal
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p data-read-path={value.readOnlyPath.admitted ? 'admitted' : 'refused'}>
        {value.readOnlyPath.admitted
          ? t('sql.class.readPathAdmitted')
          : refusal === null
            ? t('sql.class.readPathRefusedNoReason')
            : t('sql.class.readPathRefused', { code: refusal.code, reason: refusal.reason })}
      </p>
      <p className="text-foreground-lighter">
        {t('sql.class.counts', { count: value.statementCount })} {grammar}
      </p>
      <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t('sql.class.listLabel')}>
        {value.statements.map((statement) => {
          const from = lineColumnAt(text, statement.start.offset)
          const to = lineColumnAt(text, statement.end.offset)
          const excerpt = statementText(text, statement.start, statement.end)
          return (
            <li
              key={statement.index}
              className="flex flex-col gap-1.5 rounded-md border border-default p-2"
              data-statement={statement.index + 1}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {t('sql.class.statement', {
                    n: statement.index + 1,
                    from: from.line,
                    to: to.line,
                  })}
                </span>
                <UntrustedName name={statement.label} maxCodePoints={60} label="statement kind" />
                {statement.classes.length === 0 ? (
                  <span className="text-foreground-light" data-no-class="true">
                    {t('sql.class.noClass')}
                  </span>
                ) : (
                  statement.classes.map((c) => <ClassificationBadge key={c} classification={c} />)
                )}
              </div>
              {statement.procedural ? (
                <p className="text-foreground-light">{t('sql.class.procedural')}</p>
              ) : null}
              <p className="text-foreground-light">
                {statement.readOnlyPath
                  ? t('sql.class.statementReadable')
                  : statement.readOnlyRefusal === null
                    ? t('sql.class.statementNotReadable')
                    : t('sql.class.statementRefused', {
                        code: statement.readOnlyRefusal.code,
                        reason: statement.readOnlyRefusal.reason,
                      })}
              </p>
              {statement.migrationRefusal === null ? null : (
                <p className="text-foreground-light">
                  {t('sql.class.migrationRefusal', { reason: statement.migrationRefusal })}
                </p>
              )}
              <UntrustedText
                text={excerpt}
                mono
                maxCodePoints={240}
                maxLines={3}
                label={t('sql.class.excerpt')}
                className="text-xs"
              />
              <div>
                <Button
                  variant="outline"
                  size="tiny"
                  onClick={() => props.onGoTo(from.line, from.column)}
                >
                  {t('sql.class.goTo', { n: statement.index + 1 })}
                </Button>
              </div>
            </li>
          )
        })}
      </ol>
      <p className="text-foreground-lighter">{t('sql.class.notAPromise')}</p>
    </div>
  )
}
