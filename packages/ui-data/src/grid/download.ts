/** How long the object URL of a download lives: long enough for every browser to start reading it. */
export const OBJECT_URL_LIFETIME_MS = 1_000

/**
 * Hands a text to the browser as a file: a `Blob`, an object URL and a hidden
 * `<a download>` that is clicked and removed. The object URL is revoked after
 * `OBJECT_URL_LIFETIME_MS`. Nothing is opened in a window and nothing leaves the
 * page.
 */
export function downloadText(text: string, fileName: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS)
  }
}
