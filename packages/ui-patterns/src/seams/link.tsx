import {
  type AnchorHTMLAttributes,
  createContext,
  type ReactNode,
  type Ref,
  useContext,
} from 'react'

import { linkableHref } from './navigate.tsx'

/**
 * How a pattern renders a link. The app supplies its router's link (a component
 * that takes `href` and renders an `<a>`); without a provider a plain `<a href>`
 * is rendered. Patterns never import a router (design-system.md section 1).
 * `href` is always an app path the caller built from typed values, never a
 * link taken from untrusted content (C-26); an adapter renders any other value
 * without a destination (`linkableHref`).
 */
export type LinkComponentProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
  ref?: Ref<HTMLAnchorElement>
}

export type LinkComponent = (props: LinkComponentProps) => ReactNode

function PlainLink({ ref, href, ...props }: LinkComponentProps): ReactNode {
  return <a ref={ref} {...props} href={linkableHref(href)} />
}

const LinkContext = createContext<LinkComponent>(PlainLink)

export function LinkProvider({
  component,
  children,
}: {
  component: LinkComponent
  children: ReactNode
}): ReactNode {
  return <LinkContext.Provider value={component}>{children}</LinkContext.Provider>
}

export function useLinkComponent(): LinkComponent {
  return useContext(LinkContext)
}
