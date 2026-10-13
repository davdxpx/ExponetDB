// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/types.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type { ReactNode } from 'react'

import type { ShortcutId } from '../../shortcuts/definitions.ts'
import type { ReadableStore } from './state/store.ts'

/**
 * The shortcuts a command may carry. The two that belong to the menu and to the
 * help dialog (`palette.open`, `help.open`) are bound by their providers.
 */
export type CommandShortcutId = Exclude<ShortcutId, 'help.open' | 'palette.open'>

export interface IBaseCommand {
  /** Unique across the registry; it is also the identity of the entry in the list. */
  id: string
  /** What the entry says, as a command: "Go to plans". Rendered as text. */
  name: string
  /** Extra words the search matches. Not shown. */
  keywords?: readonly string[]
  /** Overrides the identity the list uses to track the selected entry (default `id`). */
  value?: string
  className?: string
  forceMount?: boolean
  badge?: () => ReactNode
  icon?: () => ReactNode
  defaultHidden?: boolean
  /**
   * The shortcut that runs this command. It is shown next to the name and bound
   * for as long as the command is registered and enabled.
   */
  shortcut?: CommandShortcutId
  /**
   * Set by the caller from what the person may do. `false` hides the command (and
   * switches its shortcut off); the menu never decides permissions itself.
   * Default `true`.
   */
  enabled?: boolean
}

export interface IActionCommand extends IBaseCommand {
  action: () => void
  /** Close the menu after the action ran. Default `false`: the action may open a page. */
  closeOnSelect?: boolean
  href?: never
}

export interface IHrefCommand extends IBaseCommand {
  /** An app path, navigated through the navigate seam. Never a link built from data. */
  href: `/${string}`
  action?: never
}

export type ICommand = IActionCommand | IHrefCommand

export const isActionCommand = (command: ICommand): command is IActionCommand => 'action' in command
export const isHrefCommand = (command: ICommand): command is IHrefCommand => 'href' in command

export interface ICommandSection {
  id: string
  name: string
  commands: readonly ICommand[]
  meta?: unknown
  forceMount?: boolean
}

export interface ICommandsState extends ReadableStore<readonly ICommandSection[]> {
  registerSection: (
    sectionName: string,
    commands: readonly ICommand[],
    options?: CommandOptions,
  ) => () => void
}

export type OrderSectionInstruction = (
  sections: readonly ICommandSection[],
  idx: number,
) => readonly ICommandSection[]
export type OrderCommandsInstruction = (
  commands: readonly ICommand[],
  commandsToInsert: readonly ICommand[],
) => readonly ICommand[]

export type CommandOptions = {
  /** Registers again when one of these changes (compared one by one with `Object.is`). */
  deps?: readonly unknown[]
  /** `false` keeps the whole registration out of the menu. Default `true`. */
  enabled?: boolean
  forceMountSection?: boolean
  sectionMeta?: unknown
  orderSection?: OrderSectionInstruction
  orderCommands?: OrderCommandsInstruction
}
