/**
 * Five-field cron in UTC (minute hour day-of-month month day-of-week) with
 * digits, `*`, lists, ranges and steps only: the policy schedules
 * (BackupScheduleSchema). Parsed strictly; anything out of range is
 * refused, never wrapped. Day-of-month and day-of-week combine as in
 * Vixie cron: when both are restricted, either matches.
 */
const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const

export interface Cron {
  readonly sets: readonly ReadonlySet<number>[]
  readonly domStar: boolean
  readonly dowStar: boolean
}

export class CronInvalid extends Error {
  override readonly name = 'CronInvalid'
}

function field(text: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (
      !Number.isInteger(step) ||
      step < 1 ||
      (stepText !== undefined && !/^[0-9]+$/.test(stepText))
    ) {
      throw new CronInvalid(`bad step in ${part}`)
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (/^[0-9]+-[0-9]+$/.test(range)) {
      const [a = '', b = ''] = range.split('-')
      lo = Number(a)
      hi = Number(b)
    } else if (/^[0-9]+$/.test(range)) {
      lo = Number(range)
      hi = stepText === undefined ? lo : max
    } else {
      throw new CronInvalid(`bad range ${range}`)
    }
    if (lo < min || hi > max || lo > hi) throw new CronInvalid(`out of range ${part}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(' ')
  if (parts.length !== 5) throw new CronInvalid('five fields')
  const sets = parts.map((p, i) => {
    const f = FIELDS[i]
    if (f === undefined) throw new CronInvalid('five fields')
    return field(p, f.min, f.max)
  })
  const dow = sets[4]
  if (dow?.has(7)) {
    dow.delete(7)
    dow.add(0)
  }
  return { sets, domStar: parts[2] === '*', dowStar: parts[4] === '*' }
}

function matches(c: Cron, d: Date): boolean {
  const [mi, h, dom, mon, dow] = c.sets
  if (!mi?.has(d.getUTCMinutes()) || !h?.has(d.getUTCHours()) || !mon?.has(d.getUTCMonth() + 1))
    return false
  const domOk = dom?.has(d.getUTCDate()) ?? false
  const dowOk = dow?.has(d.getUTCDay()) ?? false
  if (c.domStar && c.dowStar) return true
  if (c.domStar) return dowOk
  if (c.dowStar) return domOk
  return domOk || dowOk
}

/** The first minute strictly after `afterMs` that the expression matches (searches at most 400 days). */
export function nextRun(c: Cron, afterMs: number): number | null {
  let t = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  const end = afterMs + 400 * 86_400_000
  while (t <= end) {
    const d = new Date(t)
    if (!c.sets[3]?.has(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
      continue
    }
    if (!c.sets[1]?.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
      continue
    }
    if (matches(c, d)) return t
    t += 60_000
  }
  return null
}
