import type { FleetFinding } from '@exponetdb/sdk/operations'
import {
  Button,
  Checkbox,
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
  ObservedTime,
  type Readable,
  UntrustedName,
  UntrustedText,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { LiveReadView } from '../connections/live-read.tsx'
import { DiagnosticsFrame } from '../connections/page-frame.tsx'
import { nounPhrase } from '../target/phrases.ts'
import { useTargetScope } from '../target/scope.tsx'
import { useTargetHref } from '../target-ops/links.ts'
import { LoadMore, SeverityBadge } from '../target-ops/paged.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { advisorFindingsQuery } from './keys.ts'
import {
  ADVISOR_CATEGORIES,
  type AdvisorCategory,
  type AdvisorFinding,
  type AdvisorRun,
  CATEGORY_KEYS,
  evidenceText,
  SKIP_KEYS,
} from './model.ts'
import { flatPages, Missing } from './parts.tsx'

/**
 * `/t/<product>/<project>/<environment>/advisors`: live advisors run on
 * request (read-only, `runAdvisors`) for the categories the person picks,
 * with every result's level, rule, object, message, remediation and evidence,
 * the rules that did not run and why (a skipped rule is never a pass), and
 * the open advisor findings ExponetDB recorded, paged by the server. A
 * result that can become a migration only says so and links the migrations
 * area: nothing on this page writes to the target. Object names, messages
 * and evidence are untrusted text.
 */
export function AdvisorsPage(): ReactNode {
  return (
    <DiagnosticsFrame section="advisors" description={t('wave9.advisors.description')}>
      <AdvisorsBody />
    </DiagnosticsFrame>
  )
}

function AdvisorsBody(): ReactNode {
  return (
    <>
      <RunSection />
      <OpenFindingsSection />
    </>
  )
}

function RunSection(): ReactNode {
  const { client } = useApi()
  const path = useTargetScope().target.path
  const id = useId()
  const [categories, setCategories] = useState<readonly AdvisorCategory[]>([
    'security',
    'performance',
  ])
  const run = useMutation({
    mutationFn: (picked: readonly AdvisorCategory[]) =>
      client.operation('runAdvisors', {
        params: { target: path },
        body: { categories: [...picked] },
      }),
  })
  const toggle = (category: AdvisorCategory, checked: boolean): void =>
    setCategories((current) =>
      checked
        ? ADVISOR_CATEGORIES.filter((c) => c === category || current.includes(c))
        : current.filter((c) => c !== category),
    )
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (categories.length === 0 || run.isPending) return
    run.mutate(categories)
  }
  const readable: Readable<AdvisorRun> | undefined = run.isPending
    ? { state: 'loading' }
    : run.isError
      ? {
          state: 'failed',
          error: (({ code, message }) => ({ code, message }))(classifyFailure(run.error)),
        }
      : run.data === undefined
        ? undefined
        : { state: 'ready', value: run.data, source: 'live', observedAt: run.data.ranAt }
  return (
    <section aria-labelledby="advisors-run-title" className="flex flex-col gap-4">
      <h2 id="advisors-run-title" className="m-0 text-base font-medium">
        {t('wave9.advisors.run.title')}
      </h2>
      <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <fieldset className="m-0 flex flex-wrap gap-4 border-0 p-0">
          <legend className="mb-2 text-sm font-medium">{t('wave9.advisors.categories')}</legend>
          {ADVISOR_CATEGORIES.map((category) => (
            <div key={category} className="flex items-center gap-2">
              <Checkbox
                id={`${id}-${category}`}
                checked={categories.includes(category)}
                onCheckedChange={(checked) => toggle(category, checked === true)}
              />
              <Label htmlFor={`${id}-${category}`}>{t(CATEGORY_KEYS[category])}</Label>
            </div>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="small"
            variant="default"
            loading={run.isPending}
            disabled={categories.length === 0}
            aria-describedby={categories.length === 0 ? `${id}-none` : undefined}
          >
            {t('wave9.advisors.run')}
          </Button>
          {categories.length === 0 ? (
            <p id={`${id}-none`} className="m-0 text-xs text-foreground-light">
              {t('wave9.advisors.run.none')}
            </p>
          ) : (
            <p className="m-0 text-xs text-foreground-light">{t('wave9.advisors.run.readOnly')}</p>
          )}
        </div>
      </form>
      {readable === undefined ? (
        <p className="m-0 text-sm text-foreground-light" data-state="not-run">
          {t('wave9.advisors.notRun')}
        </p>
      ) : (
        <LiveReadView
          readable={readable}
          what={nounPhrase('wave9.advisors.what')}
          onRetry={() => run.mutate(categories)}
          busy={run.isPending}
          ready={(value) => <RunResult run={value} />}
        />
      )}
    </section>
  )
}

function RunResult({ run }: { readonly run: AdvisorRun }): ReactNode {
  const skipped = run.skipped ?? []
  return (
    <div className="flex flex-col gap-4" data-advisor-run={run.id ?? ''}>
      <p className="m-0 text-xs text-foreground-light">
        {t('wave9.advisors.ranAt')} <ObservedTime observedAt={run.ranAt} withDate />
        {run.catalogVersion === undefined
          ? null
          : ` ${t('wave9.advisors.catalogVersion', { version: run.catalogVersion })}`}
      </p>
      {run.findings.length === 0 ? (
        <p className="m-0 text-sm" data-empty="advisor-results">
          {skipped.length === 0
            ? t('wave9.advisors.noResults')
            : t('wave9.advisors.noResultsSkipped')}
        </p>
      ) : (
        <ResultsTable findings={run.findings} />
      )}
      {skipped.length === 0 ? null : (
        <div className="flex flex-col gap-2" data-slot="skipped">
          <h3 className="m-0 text-sm font-medium">{t('wave9.advisors.skipped')}</h3>
          <p className="m-0 text-xs text-foreground-light">{t('wave9.advisors.skipped.note')}</p>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
            {skipped.map((skip) => (
              <li key={skip.rule} data-skipped={skip.rule}>
                <UntrustedName name={skip.rule} mono />: {t(SKIP_KEYS[skip.reason])}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ResultsTable({ findings }: { readonly findings: readonly AdvisorFinding[] }): ReactNode {
  const Link = useLinkComponent()
  const href = useTargetHref()
  const path = useTargetScope().target.path
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.advisors.results')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.advisors.column.level')}</TableHead>
            <TableHead scope="col">{t('wave9.advisors.column.rule')}</TableHead>
            <TableHead scope="col">{t('wave9.advisors.column.object')}</TableHead>
            <TableHead scope="col">{t('wave9.advisors.column.message')}</TableHead>
            <TableHead scope="col">{t('wave9.advisors.column.remediation')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((finding, index) => (
            <TableRow
              key={`${finding.rule}-${finding.object ?? ''}-${String(index)}`}
              data-advisor-result={finding.rule}
            >
              <TableCell className="align-top">
                <SeverityBadge severity={finding.level} />
              </TableCell>
              <TableCell className="align-top">
                <UntrustedName name={finding.rule} mono />
                <div className="text-xs text-foreground-light">
                  {t(CATEGORY_KEYS[finding.category])}
                </div>
              </TableCell>
              <TableCell className="align-top">
                {finding.object === null ? (
                  <Missing>{t('wave9.advisors.noObject')}</Missing>
                ) : (
                  <UntrustedName name={finding.object} mono />
                )}
              </TableCell>
              <TableCell className="max-w-md align-top">
                <UntrustedText text={finding.message} maxLines={4} />
                {finding.evidence === undefined ||
                Object.keys(finding.evidence).length === 0 ? null : (
                  <dl
                    className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-2 text-xs"
                    data-evidence=""
                  >
                    {Object.entries(finding.evidence).map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-foreground-light">
                          <UntrustedName name={key} mono />
                        </dt>
                        <dd className="m-0">
                          <UntrustedName name={evidenceText(value)} mono />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </TableCell>
              <TableCell className="max-w-md align-top">
                <UntrustedText text={finding.remediation} maxLines={4} />
                <div className="mt-2 flex flex-col gap-1 text-xs">
                  {finding.draft === 'migration_draft' ? (
                    <span data-draft="">
                      {t('wave9.advisors.draft')}{' '}
                      <Link
                        href={href('/migrations')}
                        className="text-primary underline focus-ring"
                      >
                        {t('wave9.advisors.draft.link')}
                      </Link>
                    </span>
                  ) : null}
                  {finding.findingId == null ? null : (
                    <span>
                      {t('wave9.advisors.recorded')}{' '}
                      <Link
                        href={`/findings?target=${path}`}
                        className="text-primary underline focus-ring"
                        data-finding-link={finding.findingId}
                      >
                        {t('wave9.advisors.openFindings')}
                      </Link>
                    </span>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function OpenFindingsSection(): ReactNode {
  const { client } = useApi()
  const path = useTargetScope().target.path
  const query = useInfiniteQuery(advisorFindingsQuery(client, path))
  return (
    <section aria-labelledby="advisor-findings-title" className="flex flex-col gap-4">
      <h2 id="advisor-findings-title" className="m-0 text-base font-medium">
        {t('wave9.advisors.open.title')}
      </h2>
      <p className="m-0 text-sm text-foreground-light">{t('wave9.advisors.open.description')}</p>
      <ReadSection
        query={flatPages(query, (page) => page.items)}
        what={nounPhrase('wave9.advisors.open.what')}
        permission="diagnostics.read"
        missing={(value) => (value.more ? [t('wave9.list.more')] : undefined)}
        empty={{
          isEmpty: (value) => value.items.length === 0,
          content: (
            <p className="m-0 text-sm text-foreground-light" data-empty="advisor-findings">
              {t('wave9.advisors.open.empty')}
            </p>
          ),
        }}
        ready={(value) => (
          <div className="flex flex-col gap-3">
            <OpenFindingsTable findings={value.items} path={path} />
            <LoadMore
              more={value.more}
              loading={query.isFetchingNextPage}
              onLoad={() => void query.fetchNextPage()}
              label={t('wave9.list.loadMore')}
            />
          </div>
        )}
      />
    </section>
  )
}

function OpenFindingsTable({
  findings,
  path,
}: {
  readonly findings: readonly FleetFinding[]
  readonly path: string
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table>
        <TableCaption className="sr-only">{t('wave9.advisors.open.title')}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('wave9.advisors.column.level')}</TableHead>
            <TableHead scope="col">{t('wave9.advisors.column.finding')}</TableHead>
            <TableHead scope="col">{t('wave9.advisors.column.object')}</TableHead>
            <TableHead scope="col">{t('wave9.advisors.column.seen')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {findings.map((finding) => (
            <TableRow key={finding.id} data-finding={finding.id}>
              <TableCell className="align-top">
                <SeverityBadge severity={finding.severity} />
              </TableCell>
              <TableCell className="align-top">
                <UntrustedName name={finding.code} mono />
                <div>
                  <UntrustedName name={finding.summary} maxCodePoints={200} />
                </div>
                <Link
                  href={`/findings?target=${path}`}
                  className="text-xs text-primary underline focus-ring"
                >
                  {t('wave9.advisors.openFindings')}
                </Link>
              </TableCell>
              <TableCell className="align-top">
                {finding.object === null ? (
                  <Missing>{t('wave9.advisors.noObject')}</Missing>
                ) : (
                  <UntrustedName name={finding.object} mono />
                )}
              </TableCell>
              <TableCell className="align-top text-xs">
                <div>
                  {t('wave9.advisors.lastSeen')} <ObservedTime observedAt={finding.lastSeenAt} />
                </div>
                <div>{t('wave9.advisors.occurrences', { count: finding.occurrences })}</div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
