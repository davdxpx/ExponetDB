import {
  Button,
  Input,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@exponetdb/ui'
import { ReadableView, UntrustedName, useLinkComponent } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { Field, holds, NativeSelect } from '../access/fields.tsx'
import { ListView } from '../access/list-view.tsx'
import { useGuardedPlan } from '../targets/plan-request.ts'
import { type Project, productsQuery, projectsQuery, SETTINGS_PAGE_LIMIT } from './keys.ts'
import { DISPLAY_NAME, SLUG } from './products-page.tsx'
import {
  type DiffRow,
  draftOf,
  normalizeSchemas,
  type ProjectDraft,
  parseSchemas,
  projectChange,
  schemasProblem,
  skippedEvidence,
} from './project-model.ts'
import { SettingsFrame } from './settings-frame.tsx'

/**
 * `/settings/projects`: the projects of the registry (the second segment of
 * every target path) with the schemas their fingerprints and drift checks
 * cover. A new project, and every change of one, is a plan
 * (`registry.manage`): the review page opens and nothing changes until the
 * plan is applied. An edit shows, before the plan exists, what it would
 * change against what the registry holds now. Names are untrusted text.
 */
export function ProjectsPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = holds(me, 'registry.manage')
  const projects = useQuery(projectsQuery(client))
  const readable = toReadable(projects, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('settings.projects.more', { count: SETTINGS_PAGE_LIMIT })],
  })
  return (
    <SettingsFrame
      title={t('settings.projects.title')}
      description={t('settings.projects.description')}
    >
      <section aria-label={t('settings.projects.list')}>
        <ListView
          readable={readable}
          error={projects.error}
          what={t('settings.projects.what')}
          permission="targets.read"
          isEmpty={(page) => page.items.length === 0}
          emptyTitle={t('settings.projects.empty.title')}
          emptyDescription={t('settings.projects.empty.body')}
          onRetry={() => void projects.refetch()}
          busy={projects.isFetching}
        >
          {(page) =>
            page.items.length === 0 ? null : (
              <ul className="project-list m-0 flex list-none flex-col gap-2 p-0">
                {page.items.map((project) => (
                  <ProjectRow key={project.id} project={project} canManage={canManage} />
                ))}
              </ul>
            )
          }
        </ListView>
      </section>
      {canManage ? (
        <ProjectCreateForm />
      ) : (
        <p className="text-sm text-foreground-light">{t('settings.registry.missing')}</p>
      )}
    </SettingsFrame>
  )
}

function Names({ names, empty }: { readonly names: readonly string[]; readonly empty: string }) {
  if (names.length === 0) return <span>{empty}</span>
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5">
      {names.map((name) => (
        <UntrustedName key={name} name={name} mono label={t('settings.projects.scope')} />
      ))}
    </span>
  )
}

function ScopeSummary({ project }: { readonly project: Project }): ReactNode {
  const { includeSchemas, excludeSchemas } = project.managedScope
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm text-foreground-light">
      <span className="text-foreground-lighter">{t('settings.projects.scope')}:</span>
      {includeSchemas === null ? (
        <span>{t('settings.projects.scope.all')}</span>
      ) : (
        <>
          <span>{t('settings.projects.scope.include')}</span>
          <Names names={includeSchemas} empty="" />
        </>
      )}
      {excludeSchemas.length === 0 ? null : (
        <>
          <span>{t('settings.projects.scope.exclude')}</span>
          <Names names={excludeSchemas} empty="" />
        </>
      )}
    </p>
  )
}

function ProjectRow({
  project,
  canManage,
}: {
  readonly project: Project
  readonly canManage: boolean
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const formId = useId()
  const skipped = skippedEvidence(project)
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-default p-3"
      data-project={project.id}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium text-foreground">
          <UntrustedName name={project.displayName} label={t('settings.displayName')} />
        </span>
        <UntrustedName name={project.path} mono label={t('settings.slug')} />
        <span className="text-foreground-lighter">
          {t('settings.projects.revision', { revision: project.revision })}
        </span>
        {canManage ? (
          <Button
            type="button"
            variant="text"
            size="tiny"
            aria-expanded={editing}
            aria-controls={formId}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? t('settings.projects.edit.hide') : t('settings.projects.edit')}
          </Button>
        ) : null}
      </div>
      <ScopeSummary project={project} />
      <p className="m-0 text-sm text-foreground-light">
        {skipped.length === 0 ? (
          t('settings.projects.evidence.follows')
        ) : (
          <>
            {t('settings.projects.evidence.skipped')} <Names names={skipped} empty="" />
          </>
        )}
      </p>
      <div id={formId} hidden={!editing}>
        {editing ? <ProjectEditForm project={project} /> : null}
      </div>
    </li>
  )
}

type Problems = Partial<
  Record<'name' | 'include' | 'exclude' | 'product' | 'slug' | 'form', string>
>

/** The problem with a typed list of schema names, in words, or nothing when it can be sent. */
function scopeError(text: string): string | undefined {
  return schemasProblem(text) === undefined ? undefined : t('settings.projects.scope.invalid')
}

/** Only the problems that exist (a key is never present with no text). */
function problemsOf(found: Readonly<Record<string, string | undefined>>): Problems {
  const problems: Problems = {}
  for (const [key, text] of Object.entries(found)) {
    if (text !== undefined) problems[key as keyof Problems] = text
  }
  return problems
}

/** The two schema lists, one name per line. */
function ScopeFields(props: {
  readonly id: string
  readonly include: string
  readonly exclude: string
  readonly errors: Problems
  readonly onInclude: (value: string) => void
  readonly onExclude: (value: string) => void
}): ReactNode {
  return (
    <>
      <Field
        id={`${props.id}-include`}
        label={t('settings.projects.scope.include.label')}
        description={t('settings.projects.scope.include.hint')}
        error={props.errors.include}
      >
        <Textarea
          id={`${props.id}-include`}
          rows={3}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={props.include}
          aria-invalid={props.errors.include !== undefined}
          aria-describedby={`${props.id}-include-description`}
          onChange={(event) => props.onInclude(event.target.value)}
        />
      </Field>
      <Field
        id={`${props.id}-exclude`}
        label={t('settings.projects.scope.exclude.label')}
        description={t('settings.projects.scope.exclude.hint')}
        error={props.errors.exclude}
      >
        <Textarea
          id={`${props.id}-exclude`}
          rows={3}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={props.exclude}
          aria-invalid={props.errors.exclude !== undefined}
          aria-describedby={`${props.id}-exclude-description`}
          onChange={(event) => props.onExclude(event.target.value)}
        />
      </Field>
    </>
  )
}

/** A change of one project: the form, what it would change, then a plan. */
function ProjectEditForm({ project }: { readonly project: Project }): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const id = useId()
  const [draft, setDraft] = useState<ProjectDraft>(() => draftOf(project))
  const [errors, setErrors] = useState<Problems>({})
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const change = projectChange(project, draft)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const next = problemsOf({
      name: DISPLAY_NAME.test(draft.displayName.trim())
        ? undefined
        : t('settings.displayName.invalid'),
      include: scopeError(draft.include),
      exclude: scopeError(draft.exclude),
    })
    if (Object.keys(next).length === 0 && change.rows.length === 0) {
      next.form = t('settings.projects.edit.noChange')
    }
    setErrors(next)
    if (Object.keys(next).length > 0 || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await createPlan(() =>
        client.operation('planProjectChange', {
          params: { projectId: project.id },
          body: change.body,
        }),
      )
    } catch (error) {
      setErrors({ form: describeError(error) })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <form
      className="project-form flex flex-col gap-3"
      noValidate
      onSubmit={submit}
      aria-label={t('settings.projects.edit.form', { path: project.path })}
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Field id={`${id}-name`} label={t('settings.displayName')} error={errors.name}>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            maxLength={120}
            value={draft.displayName}
            aria-invalid={errors.name !== undefined}
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
          />
        </Field>
        <ScopeFields
          id={id}
          include={draft.include}
          exclude={draft.exclude}
          errors={errors}
          onInclude={(include) => setDraft({ ...draft, include })}
          onExclude={(exclude) => setDraft({ ...draft, exclude })}
        />
      </div>
      <Diff project={project} rows={change.rows} />
      {errors.form === undefined ? null : (
        <p className="m-0 text-sm text-destructive" role="alert">
          {errors.form}
        </p>
      )}
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {t('settings.projects.edit.submit')}
        </Button>
      </div>
    </form>
  )
}

function Value({ row, which }: { readonly row: DiffRow; readonly which: 'before' | 'after' }) {
  if (row.field === 'name') {
    return <UntrustedName name={row[which]} label={t('settings.displayName')} />
  }
  const names = row[which]
  return (
    <Names
      names={names}
      empty={t(
        row.field === 'include'
          ? 'settings.projects.diff.allSchemas'
          : 'settings.projects.diff.nothing',
      )}
    />
  )
}

/** Before and after of what a draft would change: a row per field that differs, nothing for the rest. */
function Diff({
  project,
  rows,
}: {
  readonly project: Project
  readonly rows: readonly DiffRow[]
}): ReactNode {
  if (rows.length === 0) return null
  return (
    <section
      aria-label={t('settings.projects.diff.title')}
      className="flex flex-col gap-2"
      data-project-diff
    >
      <h3 className="m-0 text-sm font-medium text-foreground">
        {t('settings.projects.diff.title')}
      </h3>
      <Table>
        <TableCaption className="sr-only">
          {t('settings.projects.diff.caption', { path: project.path })}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('settings.projects.diff.column.field')}</TableHead>
            <TableHead scope="col">{t('settings.projects.diff.column.before')}</TableHead>
            <TableHead scope="col">{t('settings.projects.diff.column.after')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.field} data-diff={row.field}>
              <TableCell>{t(`settings.projects.diff.${row.field}`)}</TableCell>
              <TableCell>
                <Value row={row} which="before" />
              </TableCell>
              <TableCell>
                <Value row={row} which="after" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="m-0 text-xs text-foreground-light">{t('settings.projects.diff.note')}</p>
    </section>
  )
}

/** A new project of an existing product, as a plan. */
function ProjectCreateForm(): ReactNode {
  const { client } = useApi()
  const createPlan = useGuardedPlan()
  const Link = useLinkComponent()
  const id = useId()
  const products = useQuery(productsQuery(client))
  const [product, setProduct] = useState('')
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [errors, setErrors] = useState<Problems>({})
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const next = problemsOf({
      product: product === '' ? t('settings.projects.create.product.required') : undefined,
      slug: SLUG.test(slug.trim()) ? undefined : t('settings.slug.invalid'),
      name: DISPLAY_NAME.test(name.trim()) ? undefined : t('settings.displayName.invalid'),
      include: scopeError(include),
      exclude: scopeError(exclude),
    })
    setErrors(next)
    if (Object.keys(next).length > 0 || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    const included = normalizeSchemas(parseSchemas(include))
    const excluded = normalizeSchemas(parseSchemas(exclude))
    try {
      await createPlan(() =>
        client.operation('planProject', {
          body: {
            product,
            slug: slug.trim(),
            displayName: name.trim(),
            ...(included.length === 0 && excluded.length === 0
              ? {}
              : {
                  managedScope: {
                    ...(included.length === 0 ? {} : { includeSchemas: included }),
                    excludeSchemas: excluded,
                  },
                }),
          },
        }),
      )
    } catch (error) {
      setErrors({ form: describeError(error) })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h2 id={`${id}-title`} className="text-base font-medium text-foreground">
        {t('settings.projects.create.title')}
      </h2>
      <p className="text-sm text-foreground-light">{t('settings.projects.create.description')}</p>
      <form id="project-create" className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <ReadableView
          readable={toReadable(products, {
            missing: (page) =>
              page.nextCursor === null
                ? undefined
                : [t('settings.products.more', { count: SETTINGS_PAGE_LIMIT })],
          })}
          what={t('settings.products.what')}
          onRetry={() => void products.refetch()}
          onRefresh={() => void products.refetch()}
          busy={products.isFetching}
          headingLevel={3}
          empty={{
            isEmpty: (page) => page.items.length === 0,
            content: (
              <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm text-foreground-light">
                <span>{t('settings.projects.create.product.none')}</span>
                <Link href="/settings/products" className="underline focus-ring">
                  {t('settings.projects.create.product.link')}
                </Link>
              </p>
            ),
          }}
          ready={(page) => (
            <Field
              id={`${id}-product`}
              label={t('settings.projects.create.product')}
              description={t('settings.projects.create.product.hint')}
              error={errors.product}
            >
              <NativeSelect
                id={`${id}-product`}
                value={product}
                aria-invalid={errors.product !== undefined}
                aria-describedby={`${id}-product-description`}
                options={[
                  { value: '', label: t('settings.projects.create.product.placeholder') },
                  ...page.items.map((item) => ({ value: item.slug, label: item.slug })),
                ]}
                onChange={(event) => setProduct(event.target.value)}
              />
            </Field>
          )}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            id={`${id}-slug`}
            label={t('settings.slug')}
            description={t('settings.slug.hint')}
            error={errors.slug}
          >
            <Input
              id={`${id}-slug`}
              autoComplete="off"
              spellCheck={false}
              maxLength={39}
              className="font-mono"
              value={slug}
              aria-invalid={errors.slug !== undefined}
              aria-describedby={`${id}-slug-description`}
              onChange={(event) => setSlug(event.target.value)}
            />
          </Field>
          <Field id={`${id}-name`} label={t('settings.displayName')} error={errors.name}>
            <Input
              id={`${id}-name`}
              autoComplete="off"
              maxLength={120}
              value={name}
              aria-invalid={errors.name !== undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <ScopeFields
            id={id}
            include={include}
            exclude={exclude}
            errors={errors}
            onInclude={setInclude}
            onExclude={setExclude}
          />
        </div>
        {errors.form === undefined ? null : (
          <p className="m-0 text-sm text-destructive" role="alert">
            {errors.form}
          </p>
        )}
        <div>
          <Button type="submit" variant="default" size="small" loading={busy}>
            {t('settings.projects.create.submit')}
          </Button>
        </div>
      </form>
    </section>
  )
}
