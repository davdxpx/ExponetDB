import { X } from '@exponetdb/icons'
import { Toast as ToastPrimitive } from 'radix-ui'
import * as React from 'react'

import { Button } from './button.tsx'
import { cn } from './lib/utils.ts'
import { StatusIcon, type StatusVariant } from './status-icon.tsx'

/*
 * ExponetDB's own toaster on Radix Toast: no `sonner` (it injects a <style> element at
 * run time, which `style-src 'self'` blocks) and no HTML anywhere.
 *
 *   <Toaster />                         once, near the root of the app
 *   toast.success('Plan approved')      from anywhere, no hook needed
 *   toast.error('Apply failed', { code: 'PLAN_STALE' })
 *   toast.dismiss(id)
 *
 * Rules the module enforces:
 * - at most three toasts are visible; a fourth closes the oldest;
 * - error toasts never close by themselves (the reader dismisses them); the other kinds
 *   close after a few seconds and pause while the pointer or keyboard focus is on them;
 * - content is text only: a message is rendered as a text node, so `<b>x</b>` shows
 *   literally and nothing is parsed as HTML or Markdown;
 * - the kind is shown by an icon whose shape differs per kind and is also spoken
 *   ("Error: …"), so color is never the only signal;
 * - an optional action button runs a callback and closes the toast; its label is a verb
 *   ("Undo", "View plan"). A toast is a notice, never the only way to do something.
 *
 * Toasts cannot be navigated away from: do not put information in one that the reader
 * cannot find again. Success messages are confirmations, errors point at the stable code.
 */

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

export interface ToastAction {
  /** A verb that names the outcome: "Undo", "View plan", "Retry". */
  label: string
  /** Runs when the action is pressed; the toast closes afterwards. */
  onClick: () => void
  /**
   * What screen reader users are told about the action, because the toast may be gone by
   * the time they look for it (for example "Open the plan page to view this plan").
   * Defaults to `label`.
   */
  altText?: string
}

export interface ToastOptions {
  /**
   * A stable id. Showing a toast with the id of a visible one replaces it instead of
   * stacking a duplicate.
   */
  id?: string
  /** A second, quieter line below the message. Text only. */
  description?: string
  /** An optional action button. */
  action?: ToastAction
  /**
   * Milliseconds until it closes (default depends on the kind). Ignored for errors, which
   * stay until dismissed.
   */
  duration?: number
}

export interface ToastErrorOptions extends ToastOptions {
  /** The stable error code ("PLAN_STALE"), shown so that support can find the failure. */
  code?: string
}

interface ToastRecord {
  readonly id: string
  readonly kind: ToastKind
  readonly message: string
  readonly description: string | undefined
  readonly code: string | undefined
  readonly action: ToastAction | undefined
  /** Milliseconds, or `Infinity` for a toast that stays until dismissed. */
  readonly duration: number
  /** False while the toast plays its exit animation, before it is removed. */
  readonly open: boolean
}

/** At most this many toasts are visible at once. */
export const MAX_VISIBLE_TOASTS = 3

const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  success: 4_000,
  info: 5_000,
  // A warning may carry something worth reading twice: it stays a little longer.
  warning: 8_000,
  error: Number.POSITIVE_INFINITY,
}

/** How long a closed toast stays mounted so that its exit animation can play. */
const EXIT_ANIMATION_MS = 200

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let records: readonly ToastRecord[] = []
let sequence = 0
const listeners = new Set<() => void>()
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(next: readonly ToastRecord[]): void {
  records = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): readonly ToastRecord[] {
  return records
}

function cancelRemoval(id: string): void {
  const timer = removalTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    removalTimers.delete(id)
  }
}

function scheduleRemoval(id: string): void {
  cancelRemoval(id)
  removalTimers.set(
    id,
    setTimeout(() => {
      removalTimers.delete(id)
      emit(records.filter((record) => record.id !== id))
    }, EXIT_ANIMATION_MS),
  )
}

function closeRecords(ids: ReadonlySet<string>): void {
  if (ids.size === 0) return
  emit(records.map((record) => (ids.has(record.id) ? { ...record, open: false } : record)))
  for (const id of ids) scheduleRemoval(id)
}

function dismiss(id?: string): void {
  if (id === undefined) {
    closeRecords(new Set(records.filter((record) => record.open).map((record) => record.id)))
    return
  }
  const record = records.find((candidate) => candidate.id === id)
  if (record?.open) closeRecords(new Set([id]))
}

function show(kind: ToastKind, message: string, options: ToastErrorOptions = {}): string {
  sequence += 1
  const id = options.id ?? `toast-${sequence}`
  const duration =
    kind === 'error' ? Number.POSITIVE_INFINITY : (options.duration ?? DEFAULT_DURATION_MS[kind])
  const record: ToastRecord = {
    id,
    kind,
    // Text only, whatever a caller passes: never a node, never parsed.
    message: String(message),
    description: options.description === undefined ? undefined : String(options.description),
    code: kind === 'error' && options.code !== undefined ? String(options.code) : undefined,
    action: options.action,
    duration,
    open: true,
  }

  cancelRemoval(id)
  const withoutSame = records.filter((existing) => existing.id !== id)
  const next = [...withoutSame, record]

  // Over the limit: the oldest visible toasts make room.
  const overflow = next.filter((candidate) => candidate.open).length - MAX_VISIBLE_TOASTS
  const toClose = new Set<string>()
  if (overflow > 0) {
    for (const candidate of next) {
      if (toClose.size === overflow) break
      if (candidate.open && candidate.id !== id) toClose.add(candidate.id)
    }
  }
  emit(
    next.map((candidate) =>
      toClose.has(candidate.id) ? { ...candidate, open: false } : candidate,
    ),
  )
  for (const closedId of toClose) scheduleRemoval(closedId)

  return id
}

/**
 * Shows a toast from anywhere. Each call returns the toast's id for `toast.dismiss(id)`.
 * Render `<Toaster />` once for them to appear.
 */
export const toast = {
  success: (message: string, options?: ToastOptions): string => show('success', message, options),
  info: (message: string, options?: ToastOptions): string => show('info', message, options),
  warning: (message: string, options?: ToastOptions): string => show('warning', message, options),
  /** Error toasts stay until the reader dismisses them. */
  error: (message: string, options?: ToastErrorOptions): string => show('error', message, options),
  /** Closes the toast with this id, or every toast when called without an id. */
  dismiss: (id?: string): void => dismiss(id),
  /** Removes every toast at once without an exit animation (for example on sign-out). */
  clear: (): void => {
    for (const timer of removalTimers.values()) clearTimeout(timer)
    removalTimers.clear()
    emit([])
  },
}

// ---------------------------------------------------------------------------
// Toaster
// ---------------------------------------------------------------------------

const STATUS_VARIANT: Record<ToastKind, StatusVariant> = {
  success: 'success',
  info: 'info',
  warning: 'warning',
  error: 'destructive',
}

/** Spoken before the message, because the toast text is announced without its icon. */
const KIND_LABEL: Record<ToastKind, string> = {
  success: 'Success',
  info: 'Information',
  warning: 'Warning',
  error: 'Error',
}

const KIND_CLASSES: Record<ToastKind, string> = {
  success: 'border-success/40',
  info: 'border-info/40',
  warning: 'border-warning-400',
  error: 'border-destructive-400',
}

function ToastItem({ record }: { record: ToastRecord }) {
  const { id, kind, message, description, code, action, duration, open } = record

  return (
    <ToastPrimitive.Root
      open={open}
      duration={duration}
      // Errors interrupt the reader; the rest wait for a pause in speech.
      type={kind === 'error' ? 'foreground' : 'background'}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss(id)
      }}
      data-kind={kind}
      className={cn(
        'group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border bg-overlay p-3 pr-9 text-sm text-foreground shadow-lg',
        KIND_CLASSES[kind],
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 sm:data-[state=open]:slide-in-from-right-4',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-4',
        'data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform',
        'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x) data-[swipe=move]:transition-none',
        'data-[swipe=end]:translate-x-(--radix-toast-swipe-end-x) data-[swipe=end]:animate-out data-[swipe=end]:fade-out-80',
        'motion-reduce:animate-none motion-reduce:transition-none',
        'focus-ring',
      )}
    >
      <StatusIcon variant={STATUS_VARIANT[kind]} decorative className="mt-0.5 shrink-0" />
      <div className="grid min-w-0 flex-1 gap-1">
        <ToastPrimitive.Title className="break-words font-medium">
          <span className="sr-only">{KIND_LABEL[kind]}: </span>
          {message}
        </ToastPrimitive.Title>
        {description ? (
          <ToastPrimitive.Description className="break-words text-foreground-light">
            {description}
          </ToastPrimitive.Description>
        ) : null}
        {code ? (
          <p className="font-mono text-xs text-foreground-lighter">
            <span className="sr-only">Error code: </span>
            {code}
          </p>
        ) : null}
        {action ? (
          <div className="mt-1">
            <ToastPrimitive.Action asChild altText={action.altText ?? action.label}>
              <Button size="tiny" variant="default" onClick={action.onClick}>
                {action.label}
              </Button>
            </ToastPrimitive.Action>
          </div>
        ) : null}
      </div>
      <ToastPrimitive.Close
        aria-label="Dismiss notification"
        className="focus-ring absolute right-2 top-2 rounded-xs p-0.5 text-foreground-lighter opacity-70 transition-opacity hover:opacity-100 hit-area-6"
      >
        <X size={14} aria-hidden />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  )
}

export interface ToasterProps {
  /**
   * The accessible name of the notifications region. `{hotkey}` stands for the key that
   * moves focus into it (F8). Defaults to "Notifications ({hotkey})".
   */
  label?: string
}

/**
 * Renders the toasts of the `toast` store. Mount it once, outside any route. The region is
 * at the top right on wide screens and at the bottom on narrow ones; F8 moves focus into it.
 */
export function Toaster({ label = 'Notifications ({hotkey})' }: ToasterProps) {
  const toasts = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return (
    <ToastPrimitive.Provider
      // The prefix of the spoken announcement, before the toast text.
      label="Notification"
      swipeDirection="right"
    >
      {toasts.map((record) => (
        <ToastItem key={record.id} record={record} />
      ))}
      <ToastPrimitive.Viewport
        label={label}
        className={cn(
          // The strip itself lets clicks through; each toast takes them back (pointer-events-auto).
          'pointer-events-none fixed z-100 m-0 flex w-full list-none flex-col gap-2 p-4 outline-hidden',
          // Narrow screens: along the bottom edge. Wide screens: top right.
          'inset-x-0 bottom-0 sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-0 sm:max-w-sm',
        )}
      />
    </ToastPrimitive.Provider>
  )
}
