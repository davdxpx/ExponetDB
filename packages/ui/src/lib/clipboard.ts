export type ClipboardText = string | Promise<string>

/**
 * Writes text to the clipboard and resolves to whether it worked. It never
 * rejects and shows nothing: the caller tells the person.
 *
 * Text that is already known goes through `navigator.clipboard.writeText`.
 * Text that is still loading is handed over as a `ClipboardItem` whose data is
 * a promise (Clipboard API), so the write starts inside the click that asked
 * for it, which some browsers require; where the item is refused, the loaded
 * text goes through `writeText`. Nothing is written without document focus or
 * without the Clipboard API (no `execCommand` fallback).
 */
export async function copyToClipboard(text: ClipboardText): Promise<boolean> {
  if (typeof document === 'undefined' || !document.hasFocus()) return false
  const clipboard: Clipboard | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard === undefined) return false

  if (typeof text !== 'string' && (await writeItem(clipboard, text))) return true
  try {
    await clipboard.writeText(await text)
    return true
  } catch {
    return false
  }
}

async function writeItem(clipboard: Clipboard, text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || typeof clipboard.write !== 'function') return false
  try {
    const blob = text.then((value) => new Blob([value], { type: 'text/plain' }))
    await clipboard.write([new ClipboardItem({ 'text/plain': blob })])
    return true
  } catch {
    return false
  }
}
