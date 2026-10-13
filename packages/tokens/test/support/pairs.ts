import type { Combo, PairSpec, Theme } from './browser.ts'

export type Kind = 'text' | 'non-text'

export interface Requirement extends PairSpec {
  readonly kind: Kind
  /** Minimum WCAG 2.x contrast ratio: 4.5 for text, 3 for non-text objects. */
  readonly min: number
}

const text = (id: string, fg: string, bg: string, over?: string): Requirement => ({
  id,
  fg,
  bg,
  ...(over === undefined ? {} : { over }),
  kind: 'text',
  min: 4.5,
})

const nonText = (id: string, fg: string, bg: string, over?: string): Requirement => ({
  id,
  fg,
  bg,
  ...(over === undefined ? {} : { over }),
  kind: 'non-text',
  min: 3,
})

/** Surfaces text sits on: the page and the elevated surfaces (surface-100, 200, 300, overlay). */
const surfaces = [
  ['background', 'background'],
  ['card (surface-100)', 'card'],
  ['muted (surface-200)', 'muted'],
  ['secondary (surface-300)', 'secondary'],
  ['popover', 'popover'],
  ['accent (hover)', 'accent'],
] as const

const textTiers = [
  ['foreground', 'foreground'],
  ['foreground-light', 'muted-foreground'],
  ['foreground-lighter', 'tertiary-foreground'],
] as const

const fills = [
  'primary',
  'primary-hover',
  'primary-solid',
  'primary-solid-hover',
  'success',
  'success-hover',
  'warning',
  'warning-hover',
  'destructive',
  'destructive-hover',
  'info',
  'production',
  'state-healthy',
  'state-degraded',
  'state-unhealthy',
  'state-unknown',
  'state-stale',
] as const

/** Foreground token of a fill token. */
function onFill(fill: string): string {
  if (fill.startsWith('primary-solid')) return 'primary-solid-foreground'
  if (fill.startsWith('primary')) return 'primary-foreground'
  const base = fill.replace(/-hover$/, '')
  return `${base}-foreground`
}

const scales = ['primary', 'success', 'warning', 'destructive'] as const

export function buildRequirements(): Requirement[] {
  const out: Requirement[] = []
  for (const [tierName, tier] of textTiers) {
    for (const [surfaceName, surface] of surfaces) {
      out.push(text(`${tierName} on ${surfaceName}`, tier, surface))
    }
  }
  for (const fill of fills) {
    out.push(text(`${onFill(fill)} on ${fill}`, onFill(fill), fill))
  }
  // A fill used as text or as an icon on the page.
  for (const color of [
    'primary',
    'success',
    'warning',
    'destructive',
    'info',
    'production',
    'state-healthy',
    'state-degraded',
    'state-unhealthy',
    'state-unknown',
    'state-stale',
  ]) {
    out.push(text(`${color} as text on background`, color, 'background'))
    out.push(text(`${color} as text on card (surface-100)`, color, 'card'))
  }
  out.push(text('production as text on production-muted', 'production', 'production-muted'))
  out.push(text('foreground on production-muted', 'foreground', 'production-muted'))
  out.push(text('foreground-light on production-muted', 'muted-foreground', 'production-muted'))
  for (const scale of scales) {
    out.push(text(`${scale}-600 on ${scale}-200`, `${scale}-600`, `${scale}-200`))
    out.push(text(`${scale}-600 on ${scale}-300`, `${scale}-600`, `${scale}-300`))
    out.push(text(`${scale}-200 on ${scale}-600`, `${scale}-200`, `${scale}-600`))
    out.push(text(`foreground on ${scale}-200`, 'foreground', `${scale}-200`))
  }
  out.push(text('sidebar-foreground on sidebar', 'sidebar-foreground', 'sidebar-background'))
  out.push(
    text(
      'sidebar-accent-foreground on sidebar-accent',
      'sidebar-accent-foreground',
      'sidebar-accent',
      'sidebar-background',
    ),
  )

  // Non-text objects: control boundaries, the focus ring, selected chrome, chart marks.
  for (const [surfaceName, surface] of surfaces) {
    out.push(nonText(`border-control on ${surfaceName}`, 'border-control', surface))
  }
  out.push(nonText('border-control-hover on background', 'border-control-hover', 'background'))
  out.push(nonText('input on background', 'input', 'background'))
  for (const [surfaceName, surface] of surfaces.slice(0, 5)) {
    out.push(nonText(`ring on ${surfaceName}`, 'ring', surface))
    out.push(nonText(`primary-bright on ${surfaceName}`, 'primary-bright', surface))
  }
  for (let n = 1; n <= 8; n += 1) {
    out.push(nonText(`chart-${n} on background`, `chart-${n}`, 'background'))
    out.push(nonText(`chart-${n} on card (surface-100)`, `chart-${n}`, 'card'))
  }
  out.push(nonText('chart-reference on background', 'chart-reference', 'background'))
  out.push(nonText('chart-muted on background', 'chart-muted', 'background'))
  return out
}

export const requirements = buildRequirements()

const hues = ['0', '60', '120', '180', '255', '300'] as const
const chromas = ['0', '0.04'] as const
const contrasts = ['0', '0.5', '1'] as const
const steps = ['0', '0.04'] as const

/** The extremes of the supported range of every input that the derivation reads. */
export const supportedRange = {
  hue: hues,
  chroma: chromas,
  contrast: contrasts,
  elevationStep: steps,
  surface: {
    light: ['0.96', '1'],
    dark: ['0.14', '0.22'],
  },
  foregroundLightness: {
    light: ['0', '0.15'],
    dark: ['0.92', '1'],
  },
} as const

/**
 * Sweep 1: theme x hue x chroma x contrast x elevation step, the rest at the theme defaults.
 * Sweep 2: the lightness inputs at their extremes, with hue, chroma, contrast and step varied.
 */
export function buildCombos(): Combo[] {
  const combos: Combo[] = []
  for (const theme of ['light', 'dark'] as const) {
    for (const hue of hues) {
      for (const chroma of chromas) {
        for (const contrast of contrasts) {
          for (const step of steps) {
            combos.push({
              theme,
              inputs: {
                '--hue': hue,
                '--chroma': chroma,
                '--contrast': contrast,
                '--elevation-step': step,
              },
            })
          }
        }
      }
    }
    for (const surface of supportedRange.surface[theme]) {
      for (const fg of supportedRange.foregroundLightness[theme]) {
        for (const hue of ['0', '120', '255'] as const) {
          for (const chroma of chromas) {
            for (const contrast of ['0', '1'] as const) {
              for (const step of steps) {
                combos.push({
                  theme,
                  inputs: {
                    '--hue': hue,
                    '--chroma': chroma,
                    '--contrast': contrast,
                    '--elevation-step': step,
                    '--surface': surface,
                    '--foreground-lightness': fg,
                  },
                })
              }
            }
          }
        }
      }
    }
  }
  return combos
}

export function describeCombo(combo: Combo): string {
  const inputs = Object.entries(combo.inputs)
    .map(([k, v]) => `${k.slice(2)}=${v}`)
    .join(' ')
  return `${combo.theme} ${inputs}`
}

export type { Theme }
