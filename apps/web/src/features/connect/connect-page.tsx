import { Copy } from '@exponetdb/icons'
import {
  Button,
  copyToClipboard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@exponetdb/ui'
import {
  Admonition,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useMemo } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import {
  type ClientGuide,
  type ClientId,
  clientGuides,
  type GuideBlock,
  isClientId,
  KIND_LABEL,
  mcpServerUrl,
  SCOPE_SETS,
} from './clients.ts'

/**
 * `/connect`: how to connect an MCP client to this installation (order §8,
 * modeled on the options and installation panels of Studio's MCP URL
 * builder, without logos). The server URL is this page's own origin plus
 * `/mcp`; the chosen client lives in the address (`?client=`, an allowlist
 * of ids checked by the route's `validateSearch`), so a link to the page
 * opens the right instructions. Commands and configurations have copy
 * buttons; nothing on the page reads data or builds a link from it.
 */
export function ConnectPage({
  client,
  origin,
}: {
  readonly client: ClientId
  /** This page's origin (`location.origin`); the URL is never taken from data. */
  readonly origin: string
}): ReactNode {
  const navigate = useNavigate()
  const url = mcpServerUrl(origin)
  const guides = useMemo(() => clientGuides(url), [url])
  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('connect.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('connect.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="default" className="flex flex-col gap-10 py-8">
        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>{t('connect.url.title')}</PageSectionTitle>
              <PageSectionDescription>{t('connect.url.description')}</PageSectionDescription>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            <Snippet label={t('connect.url.label')} text={url} />
          </PageSectionContent>
        </PageSection>

        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>{t('connect.clients.title')}</PageSectionTitle>
              <PageSectionDescription>{t('connect.clients.description')}</PageSectionDescription>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            <Tabs
              value={client}
              onValueChange={(next) => {
                // Only a known client id ever reaches the address.
                if (isClientId(next)) navigate(`/connect?client=${next}`, { replace: true })
              }}
            >
              <TabsList aria-label={t('connect.clients.label')} className="flex-wrap gap-x-5">
                {guides.map((guide) => (
                  <TabsTrigger key={guide.id} value={guide.id}>
                    {guide.name}
                  </TabsTrigger>
                ))}
              </TabsList>
              {guides.map((guide) => (
                <TabsContent key={guide.id} value={guide.id} className="mt-6">
                  <GuideSteps guide={guide} />
                </TabsContent>
              ))}
            </Tabs>
          </PageSectionContent>
        </PageSection>

        <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>{t('connect.scopes.title')}</PageSectionTitle>
              <PageSectionDescription>{t('connect.scopes.description')}</PageSectionDescription>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent className="flex flex-col gap-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('connect.scopes.work')}</TableHead>
                  <TableHead>{t('connect.scopes.scopes')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SCOPE_SETS.map((set) => (
                  <TableRow key={set.work}>
                    <TableCell>{t(set.work)}</TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">{set.scopes}</code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Admonition
              type="info"
              title={t('connect.safety.title')}
              description={t('connect.safety.body')}
            />
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

function GuideSteps({ guide }: { readonly guide: ClientGuide }): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-foreground-light">{t(KIND_LABEL[guide.kind])}</p>
      <ol className="m-0 flex list-none flex-col gap-6 p-0">
        {guide.steps.map((step, position) => (
          <li key={step.id} className="flex gap-4">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-strong text-xs text-foreground-light"
            >
              {position + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <h3 className="text-sm font-medium text-foreground">{t(step.title)}</h3>
              {step.blocks.map((block) => (
                <Block key={blockKey(block)} block={block} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function blockKey(block: GuideBlock): string {
  return block.kind === 'text' ? block.message : `${block.language}:${block.text}`
}

function Block({ block }: { readonly block: GuideBlock }): ReactNode {
  if (block.kind === 'snippet') {
    return <Snippet label={t(block.label)} text={block.text} />
  }
  if (block.tone === 'note') {
    return <Admonition type="default" description={t(block.message)} />
  }
  return <p className="text-sm text-foreground">{t(block.message)}</p>
}

async function copy(label: string, text: string): Promise<void> {
  if (await copyToClipboard(text)) {
    toast.success(t('connect.copy.done', { what: label }))
  } else {
    toast.error(t('connect.copy.failed'), {
      description: t('connect.copy.failedDetail', { what: label }),
    })
  }
}

/** A command, a configuration or the URL, as text, with a copy button. */
function Snippet({ label, text }: { readonly label: string; readonly text: string }): ReactNode {
  return (
    <figure className="m-0 overflow-hidden rounded-md border bg-surface-75">
      <figcaption className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs text-foreground-light">
        <span>{label}</span>
        <Button
          type="button"
          variant="text"
          size="tiny"
          icon={<Copy aria-hidden="true" />}
          aria-label={t('connect.copy.label', { what: label })}
          onClick={() => void copy(label, text)}
        >
          {t('connect.copy')}
        </Button>
      </figcaption>
      <pre className="m-0 whitespace-pre-wrap break-all p-3 font-mono text-xs text-foreground">
        <code>{text}</code>
      </pre>
    </figure>
  )
}
