import type { ComponentProps, ReactNode } from 'react'

/*
 * The elements of an ARIA grid made of divs. A virtualized grid positions its rows
 * absolutely and lays cells out with CSS grid, which `<table>` elements cannot do
 * reliably, so the roles are explicit here, once, instead of at every use. Each element
 * takes the ARIA attributes and the roving `tabIndex` of the pattern from its caller
 * (https://www.w3.org/WAI/ARIA/apg/patterns/grid/).
 */
type DivProps = ComponentProps<'div'>

export function AriaGrid(props: DivProps): ReactNode {
  // biome-ignore lint/a11y/useSemanticElements: a virtualized grid cannot be a table element
  return <div role="grid" {...props} />
}

export function AriaRowGroup(props: DivProps): ReactNode {
  // biome-ignore lint/a11y/useSemanticElements: a virtualized grid cannot be a table element
  return <div role="rowgroup" {...props} />
}

export function AriaRow(props: DivProps): ReactNode {
  // biome-ignore lint/a11y/useSemanticElements: a virtualized grid cannot be a table element
  // biome-ignore lint/a11y/useFocusableInteractive: a row is not a tab stop; its cells are
  return <div role="row" {...props} />
}

export function AriaColumnHeader(props: DivProps): ReactNode {
  // biome-ignore lint/a11y/useSemanticElements: a virtualized grid cannot be a table element
  // biome-ignore lint/a11y/useFocusableInteractive: the caller sets the roving tabIndex, or holds a button
  return <div role="columnheader" {...props} />
}

export function AriaGridCell(props: DivProps): ReactNode {
  // biome-ignore lint/a11y/useSemanticElements: a virtualized grid cannot be a table element
  // biome-ignore lint/a11y/useFocusableInteractive: the caller sets the roving tabIndex
  return <div role="gridcell" {...props} />
}
