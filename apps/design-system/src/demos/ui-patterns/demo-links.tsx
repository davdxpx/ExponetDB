import { type LinkComponentProps, LinkProvider, linkableHref } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

/**
 * Links inside a demo go to paths of the product (`/targets`), which the
 * design-system site does not have. This provider renders them as real
 * anchors that stay on the page when pressed, so a reader can try the
 * keyboard and the focus ring without leaving the demo.
 */
function StayLink({ href, onClick, ref, ...props }: LinkComponentProps): ReactNode {
  return (
    <a
      ref={ref}
      href={linkableHref(href)}
      onClick={(event) => {
        onClick?.(event)
        event.preventDefault()
      }}
      {...props}
    />
  )
}

export function DemoLinks({ children }: { readonly children: ReactNode }): ReactNode {
  return <LinkProvider component={StayLink}>{children}</LinkProvider>
}
