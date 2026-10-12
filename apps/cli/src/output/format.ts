import type { Block, Tone } from './model.ts'

/**
 * Small, pure formatting rules shared by the views: relative times, dashes
 * for absent values and the tone of a state word. Color is never the only
 * carrier of a state: the word is always printed.
 */
export function ago(iso: string | null | undefined, now: number): string {
  if (iso === null || iso === undefined) return '-'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '-'
  const s = Math.round((now - t) / 1000)
  if (s < 0) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export const dash = (v: string | number | boolean | null | undefined): string =>
  v === null || v === undefined || v === '' ? '-' : String(v)

const OK = new Set([
  'ok',
  'healthy',
  'active',
  'succeeded',
  'passed',
  'applied',
  'allow',
  'online',
  'confirmed',
  'resolved',
])
const WARN = new Set([
  'degraded',
  'pending',
  'pending_binding',
  'awaiting_approval',
  'queued',
  'running',
  'verifying',
  'require',
  'suspended',
  'stale',
  'needs_reconciliation',
  'warning',
  'offline',
  'unknown',
])
const ERROR = new Set([
  'failed',
  'verification_failed',
  'needs_attention',
  'deny',
  'denied',
  'revoked',
  'critical',
  'unhealthy',
  'down',
  'partially_applied',
  'error',
])

export function toneOf(state: string): Tone {
  if (OK.has(state)) return 'ok'
  if (ERROR.has(state)) return 'error'
  if (WARN.has(state)) return 'warn'
  return 'info'
}

/** The compact header of a remote view: title and the safe context line. */
export function header(
  title: string,
  context: {
    readonly server?: string
    readonly profile?: string
    readonly installationId?: string
  },
  extra: readonly (readonly [string, string])[] = [],
): Block {
  return {
    kind: 'header',
    title,
    context: [
      ...(context.profile === undefined ? [] : [['Profile', context.profile] as const]),
      ...(context.server === undefined ? [] : [['Server', context.server] as const]),
      ...(context.installationId === undefined
        ? []
        : [['Installation', context.installationId] as const]),
      ...extra,
    ],
  }
}

/** A count line under a list: "2 targets", or what is known about a partial list. */
export function countLine(n: number, noun: string, partial: boolean): Block {
  const plural = n === 1 ? noun : `${noun}s`
  return {
    kind: 'text',
    tone: partial ? 'warn' : 'muted',
    lines: [
      partial ? `${n} ${plural} shown; the list is incomplete (see the error).` : `${n} ${plural}`,
    ],
  }
}
