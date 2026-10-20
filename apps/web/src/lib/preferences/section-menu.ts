/**
 * The width of the section menu beside the page (the pages of the current
 * section, resizable on wide screens), kept per browser so a width a person
 * chose stays across pages and visits. A display preference in this browser's
 * `localStorage`; when storage is unavailable the choice lasts for the page.
 * Only a number between the panel's own limits is ever read back.
 */
export const SECTION_MENU_WIDTH_KEY = 'exdb.sidebar.sectionWidth'

/** The panel's width in pixels when nobody chose one, and the limits the panel enforces. */
export const SECTION_MENU_DEFAULT_WIDTH = 256
export const SECTION_MENU_MIN_WIDTH = 200
export const SECTION_MENU_MAX_WIDTH = 400

let current: number | undefined

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** A stored value as a width, or `undefined` for anything that is not a whole number within the limits. */
export function parseSectionMenuWidth(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{3}$/.test(value)) return undefined
  const width = Number(value)
  return width >= SECTION_MENU_MIN_WIDTH && width <= SECTION_MENU_MAX_WIDTH ? width : undefined
}

/** The width the section menu starts with: the chosen one, else the default. */
export function readSectionMenuWidth(): number {
  if (current === undefined) {
    let stored: string | null | undefined
    try {
      stored = storage()?.getItem(SECTION_MENU_WIDTH_KEY)
    } catch {
      stored = undefined
    }
    current = parseSectionMenuWidth(stored) ?? SECTION_MENU_DEFAULT_WIDTH
  }
  return current
}

/** Keeps the width a person dragged the section menu to (rounded, held within the limits). */
export function rememberSectionMenuWidth(pixels: number): void {
  if (!Number.isFinite(pixels) || pixels <= 0) return
  const width = Math.min(
    SECTION_MENU_MAX_WIDTH,
    Math.max(SECTION_MENU_MIN_WIDTH, Math.round(pixels)),
  )
  current = width
  try {
    if (width === SECTION_MENU_DEFAULT_WIDTH) storage()?.removeItem(SECTION_MENU_WIDTH_KEY)
    else storage()?.setItem(SECTION_MENU_WIDTH_KEY, String(width))
  } catch {
    // Storage refused: the choice lasts for this page.
  }
}

/** Forgets what was read, so the next read asks storage again (tests). */
export function resetSectionMenuWidthCache(): void {
  current = undefined
}
