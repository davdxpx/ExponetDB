/**
 * A coarse device label for the session list (identity.md §3): browser and
 * system family only, e.g. `Firefox on Linux`. The raw user agent is never
 * stored, logged or audited (audit records only a keyed hash, OD-8).
 */
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrom(?:e|ium)\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
]
const SYSTEMS: readonly [RegExp, string][] = [
  [/\bAndroid\b/, 'Android'],
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bLinux\b/, 'Linux'],
]

export function deviceLabel(userAgent: string | undefined): string {
  if (userAgent === undefined || userAgent.length === 0 || userAgent.length > 1024) {
    return 'Unknown device'
  }
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1]
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1]
  if (browser === undefined && system === undefined) {
    return 'Unknown device'
  }
  return `${browser ?? 'Browser'} on ${system ?? 'unknown system'}`
}
