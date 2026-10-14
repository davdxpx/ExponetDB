import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PIXELS,
  AVATAR_MIN_PIXELS,
  type AvatarMediaType,
} from '@exponetdb/contracts'

/**
 * The format check of an uploaded profile picture (owner decision S10;
 * threat-model.md, Wave 8 "user-uploaded images"). Pure: the bytes are read
 * structurally, nothing is decoded, rendered or converted, and no image
 * library is involved. A picture is accepted only when
 *
 * - its bytes are a complete PNG, JPEG or WebP file as far as their
 *   container goes: a PNG whose chunks all have a valid CRC, start with
 *   IHDR, hold at least one IDAT and end with IEND; a JPEG that starts with
 *   SOI, has exactly one baseline (SOF0) or progressive (SOF2) frame header,
 *   at least one scan and ends with EOI; a WebP whose RIFF size is exactly
 *   the file and that holds exactly one VP8 or VP8L image (in a VP8X
 *   container or not);
 * - the format read from the bytes is the declared media type;
 * - it is still: no APNG (`acTL`, `fcTL`, `fdAT`) and no animated WebP (the
 *   VP8X animation flag, `ANIM`, `ANMF`);
 * - width and height are each 32 to 1024 pixels;
 * - nothing follows the end of the image beyond {@link TRAILING_SLACK}
 *   bytes (a picture with something appended, such as a second file, is
 *   refused: a cheap guard against polyglots).
 *
 * The accepted picture is stored **without its metadata** ({@link AvatarCheck}
 * `bytes`; personal data such as a camera's GPS position, OD-8): only what a
 * browser needs to draw the image and its colors is kept, and the stripped
 * file is checked again. Kept per format:
 *
 * - PNG: the critical chunks (`IHDR`, `PLTE`, `IDAT`, `IEND`) and the
 *   ancillary chunks that change how pixels look ({@link PNG_KEPT}: `tRNS`,
 *   `gAMA`, `cHRM`, `sRGB`, `iCCP`, `cICP`, `mDCV`, `cLLI`, `sBIT`, `bKGD`,
 *   `pHYs`); every other ancillary chunk (`eXIf`, `tEXt`, `iTXt`, `zTXt`,
 *   `tIME`, private chunks) is dropped;
 * - JPEG: every segment of the image itself; of the application segments
 *   only a plain JFIF `APP0` without a thumbnail, an `APP2` ICC profile
 *   (colors) and the 12-byte Adobe `APP14` (its transform flag says whether
 *   three components are RGB or YCbCr, so dropping it would change the
 *   colors); every other `APP0`..`APP15` (Exif, XMP, JFXX or JFIF
 *   thumbnails, MPF second images, IPTC) and every comment (`COM`) is dropped;
 * - WebP: every chunk but `EXIF` and `XMP `, with the VP8X Exif and XMP
 *   flags cleared and the RIFF size of the new file;
 * - nothing after the end of the image (the tolerated slack is dropped too).
 *
 * What it cannot prove: that the compressed pixel data decodes. A browser
 * shows a broken image then; it is served with `nosniff` and a sandboxing
 * policy, so it is never anything but an image.
 */
export type AvatarCheck =
  | {
      readonly ok: true
      readonly mediaType: AvatarMediaType
      readonly width: number
      readonly height: number
      /** The picture without its metadata: the bytes to store, hash and serve. */
      readonly bytes: Uint8Array
    }
  | { readonly ok: false; readonly reason: AvatarRefusal }

export type AvatarRefusal =
  | 'empty'
  | 'too_large'
  | 'unsupported_format'
  | 'type_mismatch'
  | 'malformed'
  | 'animated'
  | 'dimensions'
  | 'trailing_data'

/** Bytes tolerated after the end of an image (some encoders pad); more is refused. */
export const TRAILING_SLACK = 16

class Refused extends Error {
  readonly reason: AvatarRefusal
  constructor(reason: AvatarRefusal) {
    super(reason)
    this.reason = reason
  }
}

const refuse = (reason: AvatarRefusal): never => {
  throw new Refused(reason)
}

function u16be(b: Uint8Array, at: number): number {
  if (at + 2 > b.length) refuse('malformed')
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
}

function u32be(b: Uint8Array, at: number): number {
  if (at + 4 > b.length) refuse('malformed')
  return (
    ((b[at] ?? 0) * 0x1000000 +
      (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0))) >>>
    0
  )
}

function u24le(b: Uint8Array, at: number): number {
  if (at + 3 > b.length) refuse('malformed')
  return (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)
}

function u32le(b: Uint8Array, at: number): number {
  if (at + 4 > b.length) refuse('malformed')
  return (
    ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) +
    (b[at + 3] ?? 0) * 0x1000000
  )
}

function ascii(b: Uint8Array, at: number, length: number): string {
  if (at + length > b.length) refuse('malformed')
  return String.fromCharCode(...b.subarray(at, at + length))
}

function startsWith(b: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((v, i) => b[at + i] === v)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(b: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff
  for (let i = from; i < to; i++) c = (CRC_TABLE[(c ^ (b[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
/** The critical chunks a still PNG may have; any other critical chunk is refused. */
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND'])
/** The chunks of an animated PNG (APNG). */
const APNG_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT'])
/** Bit depths allowed per PNG color type (PNG §11.2.2). */
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

/**
 * The ancillary PNG chunks kept: transparency and the color, gamma, HDR and
 * pixel-aspect information a browser uses to draw the pixels. None of them
 * holds free text, a time or a position (`iCCP` holds a short profile name and
 * the compressed profile).
 */
const PNG_KEPT = new Set([
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'cICP',
  'mDCV',
  'cLLI',
  'sBIT',
  'bKGD',
  'pHYs',
])

/** A parsed picture: its size and the byte ranges `[from, to)` of the file that are kept. */
interface Parsed {
  readonly width: number
  readonly height: number
  readonly bytes: Uint8Array
}

function joined(b: Uint8Array, ranges: readonly (readonly [number, number])[]): Uint8Array {
  const out = new Uint8Array(ranges.reduce((n, [from, to]) => n + (to - from), 0))
  let at = 0
  for (const [from, to] of ranges) {
    out.set(b.subarray(from, to), at)
    at += to - from
  }
  return out
}

function png(b: Uint8Array): Parsed {
  let at = PNG_SIGNATURE.length
  const kept: [number, number][] = [[0, PNG_SIGNATURE.length]]
  let width = 0
  let height = 0
  let first = true
  let images = 0
  for (;;) {
    const length = u32be(b, at)
    if (length > 0x7fffffff || at + 12 + length > b.length) refuse('malformed')
    const type = ascii(b, at + 4, 4)
    if (!/^[A-Za-z]{4}$/.test(type)) refuse('malformed')
    const data = at + 8
    if (crc32(b, at + 4, data + length) !== u32be(b, data + length)) refuse('malformed')
    if (first) {
      if (type !== 'IHDR' || length !== 13) refuse('malformed')
      width = u32be(b, data)
      height = u32be(b, data + 4)
      const depth = b[data + 8] ?? 0
      const color = b[data + 9] ?? 0
      if (!(PNG_DEPTHS[color] ?? []).includes(depth)) refuse('malformed')
      if (b[data + 10] !== 0 || b[data + 11] !== 0 || (b[data + 12] ?? 2) > 1) refuse('malformed')
      first = false
    } else if (type === 'IHDR') {
      refuse('malformed')
    }
    if (APNG_CHUNKS.has(type)) refuse('animated')
    // A critical chunk (upper-case first letter) this check does not know is refused.
    if (type.charCodeAt(0) < 0x61 && !PNG_CRITICAL.has(type)) refuse('malformed')
    if (type === 'IDAT') images++
    // Critical chunks and the drawing-relevant ancillary ones stay; text, Exif, time and the rest go.
    if (type.charCodeAt(0) < 0x61 || PNG_KEPT.has(type)) kept.push([at, data + length + 4])
    at = data + length + 4
    if (type === 'IEND') {
      if (length !== 0 || images === 0) refuse('malformed')
      break
    }
  }
  if (b.length - at > TRAILING_SLACK) refuse('trailing_data')
  return { width, height, bytes: joined(b, kept) }
}

/** JPEG frame headers: baseline (SOF0) and progressive (SOF2) are accepted, every other is refused. */
const JPEG_SOF_ACCEPTED = new Set([0xc0, 0xc2])
const JPEG_SOF_OTHER = new Set([0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

const JPEG_APP0 = 0xe0
const JPEG_APP2 = 0xe2
const JPEG_APP14 = 0xee
const JPEG_APP15 = 0xef
const JPEG_COM = 0xfe

function payloadStarts(b: Uint8Array, at: number, length: number, prefix: string): boolean {
  return length - 2 >= prefix.length && ascii(b, at + 2, prefix.length) === prefix
}

/**
 * Whether an application or comment segment stays: a plain JFIF `APP0` (16
 * bytes, no thumbnail), an `APP2` ICC profile chunk and the fixed-size Adobe
 * `APP14` (its transform flag decides the colors of a three-component image).
 * `at` is the position of the segment's length field.
 */
function jpegKeeps(b: Uint8Array, marker: number, at: number, length: number): boolean {
  if (marker === JPEG_COM) return false
  if (marker < JPEG_APP0 || marker > JPEG_APP15) return true
  if (marker === JPEG_APP0) {
    return (
      length === 16 &&
      payloadStarts(b, at, length, 'JFIF\0') &&
      b[at + 14] === 0 &&
      b[at + 15] === 0
    )
  }
  if (marker === JPEG_APP2) return payloadStarts(b, at, length, 'ICC_PROFILE\0')
  if (marker === JPEG_APP14) return length === 14 && payloadStarts(b, at, length, 'Adobe')
  return false
}

function jpeg(b: Uint8Array): Parsed {
  let at = 2
  let frame: { width: number; height: number } | undefined
  let scans = 0
  const kept: [number, number][] = [[0, 2]]
  for (;;) {
    const segment = at
    if (b[at] !== 0xff) refuse('malformed')
    // Fill bytes before a marker.
    while (b[at] === 0xff) at++
    if (at >= b.length) refuse('malformed')
    const marker = b[at] ?? 0
    at++
    if (marker === 0xd9) {
      if (frame === undefined || scans === 0) refuse('malformed')
      kept.push([segment, at])
      break
    }
    if (
      marker === 0xd8 ||
      marker === 0x00 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      // A second SOI, a stuffed zero or a restart marker outside a scan.
      refuse('malformed')
    }
    const length = u16be(b, at)
    if (length < 2 || at + length > b.length) refuse('malformed')
    if (JPEG_SOF_OTHER.has(marker)) refuse('unsupported_format')
    if (JPEG_SOF_ACCEPTED.has(marker)) {
      if (frame !== undefined) refuse('malformed')
      const components = b[at + 7] ?? 0
      if (b[at + 2] !== 8 || (components !== 1 && components !== 3)) refuse('malformed')
      if (length !== 8 + 3 * components) refuse('malformed')
      frame = { height: u16be(b, at + 3), width: u16be(b, at + 5) }
    }
    const keep = jpegKeeps(b, marker, at, length)
    at += length
    if (marker === 0xda) {
      if (frame === undefined) refuse('malformed')
      scans++
      // The entropy-coded data runs to the next marker that is neither a stuffed zero nor a restart.
      for (;;) {
        if (at + 1 >= b.length) refuse('malformed')
        if (b[at] === 0xff) {
          const next = b[at + 1] ?? 0
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            at += next === 0xff ? 1 : 2
            continue
          }
          break
        }
        at++
      }
    }
    // A segment (with its fill bytes and, for a scan, its entropy-coded data) is kept whole or dropped.
    if (keep) kept.push([segment, at])
  }
  if (frame === undefined) return refuse('malformed')
  if (b.length - at > TRAILING_SLACK) refuse('trailing_data')
  return { ...frame, bytes: joined(b, kept) }
}

/** The chunks a still WebP may hold; anything else (ANIM, ANMF, unknown) is refused. */
const WEBP_CHUNKS = new Set(['VP8X', 'ICCP', 'ALPH', 'VP8 ', 'VP8L', 'EXIF', 'XMP '])

function vp8(b: Uint8Array, data: number, size: number): { width: number; height: number } {
  if (size < 10) refuse('malformed')
  const tag = (b[data] ?? 0) | ((b[data + 1] ?? 0) << 8) | ((b[data + 2] ?? 0) << 16)
  const keyFrame = (tag & 1) === 0
  const version = (tag >> 1) & 7
  const shown = ((tag >> 4) & 1) === 1
  const partition = tag >> 5
  if (!keyFrame || version > 3 || !shown || partition > size - 10) refuse('malformed')
  if (!startsWith(b, [0x9d, 0x01, 0x2a], data + 3)) refuse('malformed')
  const w = (b[data + 6] ?? 0) | ((b[data + 7] ?? 0) << 8)
  const h = (b[data + 8] ?? 0) | ((b[data + 9] ?? 0) << 8)
  // The upper two bits are a scale for the decoder, not part of the size.
  return { width: w & 0x3fff, height: h & 0x3fff }
}

function vp8l(b: Uint8Array, data: number, size: number): { width: number; height: number } {
  if (size < 5 || b[data] !== 0x2f) refuse('malformed')
  const bits = u32le(b, data + 1)
  const width = (bits & 0x3fff) + 1
  const height = ((bits >>> 14) & 0x3fff) + 1
  const version = (bits >>> 29) & 7
  if (version !== 0) refuse('malformed')
  return { width, height }
}

/** The WebP chunks of metadata, dropped with their VP8X flags (Exif 0x08, XMP 0x04). */
const WEBP_METADATA = new Set(['EXIF', 'XMP '])
const VP8X_METADATA_FLAGS = 0x08 | 0x04

function webp(b: Uint8Array): Parsed {
  // The RIFF size covers the whole file after the first eight bytes: nothing may follow it.
  const riff = u32le(b, 4)
  if (riff + 8 < b.length) refuse('trailing_data')
  if (riff + 8 > b.length || riff % 2 !== 0) refuse('malformed')
  let at = 12
  let canvas: { width: number; height: number } | undefined
  let image: { width: number; height: number } | undefined
  let index = 0
  let flagsAt: number | undefined
  const kept: [number, number][] = []
  while (at < b.length) {
    const fourcc = ascii(b, at, 4)
    const size = u32le(b, at + 4)
    const data = at + 8
    if (data + size > b.length) refuse('malformed')
    if (fourcc === 'ANIM' || fourcc === 'ANMF') refuse('animated')
    if (!WEBP_CHUNKS.has(fourcc)) refuse('malformed')
    if (fourcc === 'VP8X') {
      if (index !== 0 || size !== 10) refuse('malformed')
      const flags = b[data] ?? 0
      if ((flags & 0x02) !== 0) refuse('animated')
      flagsAt = data
      canvas = { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 }
    } else if (fourcc === 'VP8 ' || fourcc === 'VP8L') {
      if (image !== undefined) refuse('malformed')
      image = fourcc === 'VP8 ' ? vp8(b, data, size) : vp8l(b, data, size)
    } else if (canvas === undefined) {
      // ICCP, ALPH, EXIF and XMP exist only in the extended format.
      refuse('malformed')
    }
    const end = data + size + (size % 2)
    if (!WEBP_METADATA.has(fourcc)) kept.push([at, end])
    at = end
    index++
  }
  if (at !== b.length || image === undefined) return refuse('malformed')
  if (canvas !== undefined && (canvas.width !== image.width || canvas.height !== image.height)) {
    refuse('malformed')
  }
  // The new file: the RIFF header with the size of what is kept, the kept chunks, and the
  // VP8X flags of the dropped metadata cleared.
  const body = joined(b, kept)
  const out = new Uint8Array(12 + body.length)
  out.set(b.subarray(0, 12))
  out.set(body, 12)
  const riffSize = out.length - 8
  out[4] = riffSize & 0xff
  out[5] = (riffSize >>> 8) & 0xff
  out[6] = (riffSize >>> 16) & 0xff
  out[7] = (riffSize >>> 24) & 0xff
  if (flagsAt !== undefined) {
    // VP8X is the first chunk: its flag byte is at the same place in the new file.
    out[flagsAt] = (out[flagsAt] ?? 0) & ~VP8X_METADATA_FLAGS
  }
  return { ...image, bytes: out }
}

function detect(b: Uint8Array): AvatarMediaType | undefined {
  if (startsWith(b, PNG_SIGNATURE)) return 'image/png'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'
  }
  return undefined
}

/** Checks the bytes of an upload declared as `declared` (the request's media type). */
export function checkAvatarImage(bytes: Uint8Array, declared: string): AvatarCheck {
  try {
    if (bytes.length === 0) return refuse('empty')
    if (bytes.length > AVATAR_MAX_BYTES) return refuse('too_large')
    const detected = detect(bytes)
    if (detected === undefined) return refuse('unsupported_format')
    if (detected !== declared) return refuse('type_mismatch')
    const parse = detected === 'image/png' ? png : detected === 'image/jpeg' ? jpeg : webp
    const { width, height, bytes: stripped } = parse(bytes)
    // The stripped file passes the same check, at the same size, and has nothing left to strip.
    const again = parse(stripped)
    if (
      again.width !== width ||
      again.height !== height ||
      again.bytes.length !== stripped.length ||
      !again.bytes.every((v, i) => v === stripped[i])
    ) {
      return refuse('malformed')
    }
    if (
      width < AVATAR_MIN_PIXELS ||
      height < AVATAR_MIN_PIXELS ||
      width > AVATAR_MAX_PIXELS ||
      height > AVATAR_MAX_PIXELS
    ) {
      return refuse('dimensions')
    }
    return { ok: true, mediaType: detected, width, height, bytes: stripped }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason }
    throw error
  }
}
