import type { ReactNode } from 'react'

export interface CspCase {
  readonly id: string
  readonly title: string
  readonly render: () => ReactNode
  /** Runs after the first frame (opens what has no `open` prop, scrolls, shows toasts). */
  readonly act?: () => void | Promise<void>
}
