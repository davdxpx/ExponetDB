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
} from '@exponetdb/ui'
import { UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { Field, holds } from '../access/fields.tsx'
import { ListView } from '../access/list-view.tsx'
import { type StatusLine, StatusLines, useStatusLine } from '../access/status.tsx'
import { type Product, productsQuery, SETTINGS_PAGE_LIMIT } from './keys.ts'
import { SettingsFrame } from './settings-frame.tsx'

/**
 * `/settings/products`: the products of the registry (the first segment of
 * every target path). A new product is a plan (`POST /products`, needs
 * `registry.manage`); its review page opens and nothing exists until it is
 * applied. Display names are untrusted text.
 */
export const SLUG = /^[a-z][a-z0-9-]{0,38}$/
export const DISPLAY_NAME = /^[^\p{Cc}]{1,120}$/u

export function ProductsPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const line = useStatusLine()
  const products = useQuery(productsQuery(client))
  const readable = toReadable(products, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('settings.products.more', { count: SETTINGS_PAGE_LIMIT })],
  })
  return (
    <SettingsFrame
      title={t('settings.products.title')}
      description={t('settings.products.description')}
    >
      <StatusLines line={line} />
      <section aria-label={t('settings.products.list')}>
        <ListView
          readable={readable}
          error={products.error}
          what={t('settings.products.what')}
          permission="targets.read"
          isEmpty={(page) => page.items.length === 0}
          emptyTitle={t('settings.products.empty.title')}
          emptyDescription={t('settings.products.empty.body')}
          onRetry={() => void products.refetch()}
          busy={products.isFetching}
        >
          {(page) => (page.items.length === 0 ? null : <ProductTable products={page.items} />)}
        </ListView>
      </section>
      {holds(me, 'registry.manage') ? (
        <ProductForm line={line} />
      ) : (
        <p className="text-sm text-foreground-light">{t('settings.registry.missing')}</p>
      )}
    </SettingsFrame>
  )
}

function ProductTable({ products }: { readonly products: readonly Product[] }): ReactNode {
  return (
    <Table id="product-list">
      <TableCaption className="sr-only">{t('settings.products.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('settings.products.column.name')}</TableHead>
          <TableHead scope="col">{t('settings.products.column.slug')}</TableHead>
          <TableHead scope="col">{t('settings.products.column.id')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((product) => (
          <TableRow key={product.id} data-product={product.id}>
            <TableCell>
              <UntrustedName
                name={product.displayName}
                label={t('settings.products.column.name')}
              />
            </TableCell>
            <TableCell>
              <code className="font-mono text-xs">{product.slug}</code>
            </TableCell>
            <TableCell>
              <code className="font-mono text-xs">{product.id}</code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function ProductForm({ line }: { readonly line: StatusLine }): ReactNode {
  const { client } = useApi()
  const createPlan = usePlanAction()
  const id = useId()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [errors, setErrors] = useState<{ slug?: string; name?: string }>({})
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const next = {
      ...(SLUG.test(slug.trim()) ? {} : { slug: t('settings.slug.invalid') }),
      ...(DISPLAY_NAME.test(name.trim()) ? {} : { name: t('settings.displayName.invalid') }),
    }
    setErrors(next)
    if (next.slug !== undefined || next.name !== undefined || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    line.clear()
    try {
      await createPlan(() =>
        client.operation('planProduct', {
          body: { slug: slug.trim(), displayName: name.trim() },
        }),
      )
    } catch (error) {
      line.fail(error)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h2 id={`${id}-title`} className="text-base font-medium text-foreground">
        {t('settings.products.create.title')}
      </h2>
      <p className="text-sm text-foreground-light">{t('settings.products.create.description')}</p>
      <form id="product-create" className="flex flex-col gap-3" noValidate onSubmit={submit}>
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
        </div>
        <div>
          <Button type="submit" variant="default" size="small" loading={busy}>
            {t('settings.products.create.submit')}
          </Button>
        </div>
      </form>
    </section>
  )
}
