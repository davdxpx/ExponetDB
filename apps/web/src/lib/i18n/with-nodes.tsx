import { Fragment, type ReactNode } from 'react'

/**
 * A catalog sentence whose `{name}` placeholders are filled with nodes (an
 * untrusted host, a target path, a code): the text around them stays the
 * catalog's, the nodes are rendered as they are. Placeholders without a node
 * stay visible.
 */
export function withNodes(text: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode {
  const out: ReactNode[] = []
  let offset = 0
  for (const part of text.split(/(\{[A-Za-z]+\})/)) {
    if (part === '') continue
    const name = /^\{([A-Za-z]+)\}$/.exec(part)?.[1]
    const node = name === undefined ? undefined : nodes[name]
    out.push(<Fragment key={offset}>{node === undefined ? part : node}</Fragment>)
    offset += part.length
  }
  return out
}
