// Derived from supabase/supabase packages/ui-patterns/src/Admonition/Admonition.types.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type { HTMLAttributes, ReactNode } from 'react'

/** The variants of `Alert` in the UI package; each has its own icon shape as well as its own color. */
export type AdmonitionType = 'default' | 'info' | 'success' | 'warning' | 'destructive'

export type AdmonitionLayout = 'horizontal' | 'vertical' | 'responsive'

export interface AdmonitionProps {
  type?: AdmonitionType
  /** Plain text. It renders as a text node, never as Markdown or HTML. */
  title?: string
  description?: ReactNode
  children?: ReactNode
  /** Shows the icon of the type (default) or the `icon` given. */
  showIcon?: boolean
  childProps?: {
    title?: HTMLAttributes<HTMLParagraphElement>
    description?: HTMLAttributes<HTMLDivElement>
  }
  layout?: AdmonitionLayout
  actions?: ReactNode
  /** Replaces the icon of the type. */
  icon?: ReactNode
  className?: string
}
