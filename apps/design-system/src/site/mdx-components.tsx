import { isAppPath, useLinkComponent } from '@exponetdb/ui-patterns'
import type { ComponentProps, ReactNode } from 'react'
import { Demo } from './demo.tsx'

/**
 * How MDX elements render on a page: typography from the tokens, internal
 * links through the link seam, and `<Demo id="…" />` available on every page
 * without an import. The content is ours (trusted); untrusted-content rules
 * apply to the demos' mock data like to the product.
 */
const linkClass = 'text-foreground underline underline-offset-2 focus-ring'

function Anchor({ href, children }: ComponentProps<'a'>): ReactNode {
  const Link = useLinkComponent()
  if (href !== undefined && isAppPath(href)) {
    return (
      <Link href={href} className={linkClass}>
        {children}
      </Link>
    )
  }
  // External references open as plain links without the referrer (the site sets no-referrer too).
  return (
    <a href={href} rel="noreferrer" className={linkClass}>
      {children}
    </a>
  )
}

export const mdxComponents = {
  h1: (props: ComponentProps<'h1'>) => (
    <h1 className="mb-4 text-3xl font-medium tracking-tight text-foreground" {...props} />
  ),
  h2: (props: ComponentProps<'h2'>) => (
    <h2 className="mt-10 mb-3 text-xl font-medium text-foreground" {...props} />
  ),
  h3: (props: ComponentProps<'h3'>) => (
    <h3 className="mt-6 mb-2 text-base font-medium text-foreground" {...props} />
  ),
  p: (props: ComponentProps<'p'>) => (
    <p className="my-3 text-sm leading-6 text-foreground-light" {...props} />
  ),
  ul: (props: ComponentProps<'ul'>) => (
    <ul
      className="my-3 list-disc space-y-1 pl-6 text-sm leading-6 text-foreground-light"
      {...props}
    />
  ),
  ol: (props: ComponentProps<'ol'>) => (
    <ol
      className="my-3 list-decimal space-y-1 pl-6 text-sm leading-6 text-foreground-light"
      {...props}
    />
  ),
  li: (props: ComponentProps<'li'>) => <li {...props} />,
  strong: (props: ComponentProps<'strong'>) => (
    <strong className="font-medium text-foreground" {...props} />
  ),
  code: (props: ComponentProps<'code'>) => (
    <code
      className="rounded-sm bg-surface-200 px-1 py-0.5 font-mono text-xs text-foreground"
      {...props}
    />
  ),
  pre: (props: ComponentProps<'pre'>) => (
    <pre
      className="my-4 overflow-x-auto rounded-md border border-default bg-surface-75 p-4 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    />
  ),
  table: (props: ComponentProps<'table'>) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm" {...props} />
    </div>
  ),
  th: (props: ComponentProps<'th'>) => (
    <th className="border-b border-default px-3 py-2 font-medium text-foreground" {...props} />
  ),
  td: (props: ComponentProps<'td'>) => (
    <td className="border-b border-muted px-3 py-2 align-top text-foreground-light" {...props} />
  ),
  a: Anchor,
  Demo,
}
