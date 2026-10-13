/**
 * Names for the characters `segmentLine` shows as code points, so a screen
 * reader can say what a hidden character is ("right-to-left override") and not
 * only its number. Characters without a name get the name of their class.
 */
const NAMES: Readonly<Record<number, string>> = {
  0: 'null',
  9: 'tab',
  10: 'line feed',
  13: 'carriage return',
  27: 'escape',
  173: 'soft hyphen',
  847: 'combining grapheme joiner',
  1564: 'Arabic letter mark',
  4447: 'Hangul choseong filler',
  4448: 'Hangul jungseong filler',
  6068: 'Khmer vowel inherent AQ',
  6069: 'Khmer vowel inherent AA',
  6158: 'Mongolian vowel separator',
  8203: 'zero width space',
  8204: 'zero width non-joiner',
  8205: 'zero width joiner',
  8206: 'left-to-right mark',
  8207: 'right-to-left mark',
  8232: 'line separator',
  8233: 'paragraph separator',
  8234: 'left-to-right embedding',
  8235: 'right-to-left embedding',
  8236: 'pop directional formatting',
  8237: 'left-to-right override',
  8238: 'right-to-left override',
  8288: 'word joiner',
  8294: 'left-to-right isolate',
  8295: 'right-to-left isolate',
  8296: 'first strong isolate',
  8297: 'pop directional isolate',
  12644: 'Hangul filler',
  65279: 'zero width no-break space',
  65440: 'halfwidth Hangul filler',
}

/** `U+202E`: the code point as the labels show it, without the angle brackets. */
export function codePointId(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
}

/** What a hidden character is, in words: its name, or the name of its class. */
export function describeCodePoint(cp: number): string {
  const named = NAMES[cp]
  if (named !== undefined) return named
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 'control character'
  if (cp === 0xe0001 || (cp >= 0xe0020 && cp <= 0xe007f)) return 'tag character'
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef))
    return 'variation selector'
  if (cp >= 0x2061 && cp <= 0x206f) return 'invisible formatting character'
  return 'invisible character'
}
