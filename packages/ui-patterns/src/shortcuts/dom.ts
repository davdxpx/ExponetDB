/**
 * What the document around a key press allows. Letters typed into a field or
 * over an open dialog are never shortcuts.
 */

const TEXT_ENTRY_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Elements whose own keyboard handling would clash with a letter shortcut. */
const INTERACTIVE_WIDGET = [
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="spinbutton"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
].join(',')

/** Open dialogs: Radix marks an open one with `data-state="open"`, a native one has `open`. */
const OPEN_DIALOG = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  'dialog[open]',
].join(',')

/** The command menu marks its dialog with this attribute: it may be toggled by its own shortcut. */
export const COMMAND_MENU_ATTRIBUTE = 'data-command-menu'

/** True when the key press happens in (or inside) something the user types into or steers with letters. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (TEXT_ENTRY_TAGS.has(target.tagName)) return true
  return target.closest(INTERACTIVE_WIDGET) !== null
}

/** True when a modal dialog is open. With `except`, dialogs that match it are not counted. */
export function hasOpenDialog(root: ParentNode, except?: string): boolean {
  for (const dialog of root.querySelectorAll(OPEN_DIALOG)) {
    if (except === undefined || !dialog.matches(except)) return true
  }
  return false
}
