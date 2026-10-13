// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/useTabIndicator.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { type RefObject, useLayoutEffect } from 'react'

type IndicatorOptions = {
  activeItemSelector?: string
  indicatorSelector?: string
  readyFlag?: string
  leftProperty?: string
  widthProperty?: string
  insetByPadding?: boolean
}

const tabDefaults = {
  activeItemSelector: '[role="tab"][data-state="active"]',
  indicatorSelector: '[data-tab-indicator]',
  readyFlag: 'tabIndicatorReady',
  leftProperty: '--active-tab-left',
  widthProperty: '--active-tab-width',
  insetByPadding: true,
} satisfies Required<IndicatorOptions>

/**
 * Positions the underline of a tab list under the active tab. The position goes to the list as
 * two custom properties through `style.setProperty` (a CSSOM write) and a data attribute marks the
 * first measurement, so the animation is plain CSS on `--active-tab-left` and `--active-tab-width`
 * and nothing is injected into the document.
 */
export const useTabIndicator = (
  listRef: RefObject<HTMLElement | null>,
  options: IndicatorOptions = {},
) => {
  const {
    activeItemSelector,
    indicatorSelector,
    readyFlag,
    leftProperty,
    widthProperty,
    insetByPadding,
  } = { ...tabDefaults, ...options }

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list?.querySelector(`:scope > ${indicatorSelector}`)) return

    let cancelled = false

    const measure = () => {
      const trigger = list.querySelector<HTMLElement>(`:scope > ${activeItemSelector}`)
      if (cancelled) return
      if (!trigger) {
        delete list.dataset[readyFlag]
        return
      }

      const styles = getComputedStyle(trigger)
      const paddingLeft = insetByPadding ? parseFloat(styles.paddingLeft) || 0 : 0
      const paddingRight = insetByPadding ? parseFloat(styles.paddingRight) || 0 : 0

      list.style.setProperty(leftProperty, `${trigger.offsetLeft + paddingLeft}px`)
      list.style.setProperty(widthProperty, `${trigger.offsetWidth - paddingLeft - paddingRight}px`)
      if (list.dataset[readyFlag] === undefined) {
        // makes the bar already sitting on the active tab rather than sliding in
        requestAnimationFrame(() => {
          if (!cancelled) list.dataset[readyFlag] = ''
        })
      }
    }

    const resizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    const sync = () => {
      resizes?.disconnect()
      resizes?.observe(list)
      for (const child of Array.from(list.children)) {
        resizes?.observe(child)
      }
      measure()
    }

    sync()

    const mutations =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(sync)
    mutations?.observe(list, {
      attributes: true,
      attributeFilter: ['data-state'],
      subtree: true,
      childList: true,
    })

    // label widths shift when webfonts land
    document.fonts?.ready.then(measure).catch(() => {})

    return () => {
      cancelled = true
      mutations?.disconnect()
      resizes?.disconnect()
      delete list.dataset[readyFlag]
    }
  }, [
    listRef,
    activeItemSelector,
    indicatorSelector,
    readyFlag,
    leftProperty,
    widthProperty,
    insetByPadding,
  ])
}
