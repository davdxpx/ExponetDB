export type Rgb = readonly [number, number, number]

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Relative luminance of an sRGB color with 8-bit channels (WCAG 2.x). */
export function luminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** OKLab coordinates of an sRGB color with 8-bit channels. */
export function toOklab(rgb: Rgb): { L: number; a: number; b: number } {
  const r = channel(rgb[0])
  const g = channel(rgb[1])
  const bl = channel(rgb[2])
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

/** Hue angle of the OKLCH form, in degrees 0 to 360. */
export function oklchHue(rgb: Rgb): number {
  const { a, b } = toOklab(rgb)
  const h = (Math.atan2(b, a) * 180) / Math.PI
  return h < 0 ? h + 360 : h
}

/** Euclidean distance in OKLab (delta E OK). */
export function deltaEOk(x: Rgb, y: Rgb): number {
  const p = toOklab(x)
  const q = toOklab(y)
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b)
}

/** Smallest angle between two hues, 0 to 180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
