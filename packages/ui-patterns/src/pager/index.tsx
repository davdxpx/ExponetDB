import { ChevronLeft, ChevronRight } from '@exponetdb/icons'
import { Button, cn } from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'

/** The page sizes a list offers by default. */
export const PAGE_SIZES = [25, 50, 100] as const

/** The pages `total` items fill at `size` per page; at least one, so "page 1 of 1" holds for none. */
export function pageCount(total: number, size: number): number {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(size) || size <= 0) return 1
  return Math.ceil(total / Math.floor(size))
}

/** `page` (1-based) moved into the pages that exist: a deep link past the end opens the last page. */
export function clampPage(page: number, total: number, size: number): number {
  const last = pageCount(total, size)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(Math.floor(page), last)
}

/** The items of one page (1-based, clamped), and their 1-based positions for "26–50 of 512". */
export function pageSlice<T>(
  items: readonly T[],
  page: number,
  size: number,
): {
  readonly items: readonly T[]
  readonly page: number
  readonly from: number
  readonly to: number
} {
  const current = clampPage(page, items.length, size)
  const start = (current - 1) * Math.floor(size)
  const slice = items.slice(start, start + Math.floor(size))
  return {
    items: slice,
    page: current,
    from: slice.length === 0 ? 0 : start + 1,
    to: start + slice.length,
  }
}

/** The words of the pager; the app passes them from its message catalog. */
export interface PagerText {
  readonly previous: string
  readonly next: string
  /** "51–100 of 512". */
  readonly range: (from: number, to: number, total: number) => string
  /** "Page 3 of 11". */
  readonly page: (page: number, pages: number) => string
  readonly pageSize: string
}

export interface PagerProps {
  /** Names the navigation landmark ("Migration history pages"). */
  readonly label: string
  /** 1-based; the caller clamps it with `clampPage`. */
  readonly page: number
  readonly pageSize: number
  readonly total: number
  readonly onPage: (page: number) => void
  /** Offer a page size choice; left out, the size is fixed. */
  readonly onPageSize?: (size: number) => void
  readonly pageSizes?: readonly number[]
  readonly text: PagerText
  /**
   * What the total counts and where it comes from ("all 512 entries of one ledger read"), so a
   * page of a list read whole is never mistaken for a page the server cut.
   */
  readonly note?: ReactNode
  readonly className?: string
}

/**
 * Previous, next and the range shown, for a list too long for one screen. It is a named
 * navigation landmark; the range is a polite live region, so a screen reader hears the new range
 * after a press. The buttons are real buttons and stay in place when they are disabled (the
 * layout never shifts under the pointer).
 */
export function Pager({
  label,
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  pageSizes = PAGE_SIZES,
  text,
  note,
  className,
}: PagerProps): ReactNode {
  const sizeId = useId()
  const pages = pageCount(total, pageSize)
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <nav
      aria-label={label}
      data-slot="pager"
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-foreground-light',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 tabular-nums text-foreground" aria-live="polite">
          {text.range(from, to, total)}
        </p>
        {note === undefined ? null : <div className="text-foreground-lighter">{note}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSize === undefined ? null : (
          <span className="flex items-center gap-1.5">
            <label htmlFor={sizeId}>{text.pageSize}</label>
            <select
              id={sizeId}
              value={pageSize}
              onChange={(event) => onPageSize(Number(event.target.value))}
              className="h-[26px] cursor-pointer rounded-md border border-control bg-field px-1.5 text-xs text-foreground focus-ring"
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </span>
        )}
        <span className="tabular-nums">{text.page(page, pages)}</span>
        <Button
          type="button"
          variant="default"
          size="tiny"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          icon={<ChevronLeft aria-hidden="true" strokeWidth={1.5} />}
        >
          {text.previous}
        </Button>
        <Button
          type="button"
          variant="default"
          size="tiny"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          iconRight={<ChevronRight aria-hidden="true" strokeWidth={1.5} />}
        >
          {text.next}
        </Button>
      </div>
    </nav>
  )
}
