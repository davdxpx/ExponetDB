import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { checkAvatarImage, TRAILING_SLACK } from '../src/avatar-image.ts'

/**
 * The format check of a profile picture (owner decision S10): minimal files
 * built here byte by byte, so every accepted and every refused shape is
 * visible in the test.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const cat = (...parts: (Uint8Array | readonly number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => [...p]))
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

function pngChunk(type: string, data: readonly number[] | Uint8Array): Uint8Array {
  const body = cat(ascii(type), data)
  return cat(be32(data.length), body, be32(crc32(body)))
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function png(
  width = 64,
  height = 64,
  extra: Uint8Array[] = [],
  ihdr: { depth?: number; color?: number } = {},
): Uint8Array {
  const header = [...be32(width), ...be32(height), ihdr.depth ?? 8, ihdr.color ?? 2, 0, 0, 0]
  const rows = new Uint8Array(Math.min(height, 4) * (1 + Math.min(width, 4) * 3))
  return cat(
    PNG_SIG,
    pngChunk('IHDR', header),
    ...extra,
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', []),
  )
}

function jpeg(
  width = 64,
  height = 64,
  options: { sof?: number; scans?: number; eoi?: boolean } = {},
): Uint8Array {
  const sof = options.sof ?? 0xc0
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const frame = [
    0xff,
    sof,
    0x00,
    17,
    8,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]
  const scan = [0xff, 0xda, 0x00, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]
  // Entropy-coded data with a stuffed zero and a restart marker inside.
  const data = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]
  const scans = Array.from({ length: options.scans ?? 1 }, () => [...scan, ...data]).flat()
  return Uint8Array.from([
    0xff,
    0xd8,
    ...app0,
    ...frame,
    ...scans,
    ...(options.eoi === false ? [] : [0xff, 0xd9]),
  ])
}

function riff(chunks: Uint8Array[]): Uint8Array {
  const body = cat(ascii('WEBP'), ...chunks)
  return cat(ascii('RIFF'), le32(body.length), body)
}

function webpChunk(fourcc: string, data: readonly number[] | Uint8Array): Uint8Array {
  return cat(ascii(fourcc), le32(data.length), data, data.length % 2 === 1 ? [0] : [])
}

function vp8(width = 64, height = 64): Uint8Array {
  const partition = 4
  const tag = (0 << 0) | (0 << 1) | (1 << 4) | (partition << 5)
  return webpChunk('VP8 ', [
    tag & 0xff,
    (tag >> 8) & 0xff,
    (tag >> 16) & 0xff,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    (width >> 8) & 0x3f,
    height & 0xff,
    (height >> 8) & 0x3f,
    1,
    2,
    3,
    4,
  ])
}

function vp8l(width = 64, height = 64): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14) | (1 << 28)) >>> 0
  return webpChunk('VP8L', [0x2f, ...le32(bits), 0x10, 0x20, 0x30])
}

function vp8x(width = 64, height = 64, flags = 0x10): Uint8Array {
  return webpChunk('VP8X', [flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)])
}

describe('checkAvatarImage accepts still pictures of the three formats', () => {
  it.each([
    ['PNG', png(), 'image/png', 64, 64],
    [
      'PNG with a palette and ancillary chunks',
      png(48, 96, [pngChunk('PLTE', [0, 0, 0]), pngChunk('tIME', [7, 234, 10, 13, 12, 0, 0])], {
        color: 3,
      }),
      'image/png',
      48,
      96,
    ],
    ['PNG at the bounds', png(32, 1024), 'image/png', 32, 1024],
    ['baseline JPEG', jpeg(), 'image/jpeg', 64, 64],
    [
      'progressive JPEG with several scans',
      jpeg(200, 120, { sof: 0xc2, scans: 3 }),
      'image/jpeg',
      200,
      120,
    ],
    ['lossy WebP', riff([vp8()]), 'image/webp', 64, 64],
    ['lossless WebP', riff([vp8l(100, 50)]), 'image/webp', 100, 50],
    ['extended WebP', riff([vp8x(80, 80), vp8l(80, 80)]), 'image/webp', 80, 80],
    [
      'extended WebP with alpha and EXIF',
      riff([vp8x(64, 64), webpChunk('ALPH', [0, 1, 2]), vp8(), webpChunk('EXIF', [1, 2])]),
      'image/webp',
      64,
      64,
    ],
  ] as const)('%s', (_name, bytes, type, width, height) => {
    expect(checkAvatarImage(bytes, type)).toEqual({ ok: true, mediaType: type, width, height })
  })

  it('tolerates a few padding bytes after the end of the image', () => {
    expect(checkAvatarImage(cat(png(), new Uint8Array(TRAILING_SLACK)), 'image/png').ok).toBe(true)
    expect(checkAvatarImage(cat(jpeg(), new Uint8Array(TRAILING_SLACK)), 'image/jpeg').ok).toBe(
      true,
    )
  })
})

describe('checkAvatarImage refuses', () => {
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>',
  )
  const gif = cat(ascii('GIF89a'), [64, 0, 64, 0, 0, 0, 0], ascii(';'))
  const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>')
  const polyglotTail = new TextEncoder().encode(
    '<html><script>alert(document.cookie)</script></html>',
  )
  const apng = png(64, 64, [pngChunk('acTL', [...be32(2), ...be32(0)])])
  const apngFrame = png(64, 64, [pngChunk('fcTL', new Array(26).fill(0))])
  const animatedWebp = riff([
    vp8x(64, 64, 0x12),
    webpChunk('ANIM', [0, 0, 0, 0, 0, 0]),
    webpChunk('ANMF', new Array(16).fill(0)),
  ])
  const animFlagOnly = riff([vp8x(64, 64, 0x02), vp8l()])
  const anmfWithoutFlag = riff([vp8x(64, 64, 0x10), webpChunk('ANMF', new Array(16).fill(0))])
  const goodPng = png()
  const badCrc = Uint8Array.from(goodPng)
  badCrc[30] = (badCrc[30] ?? 0) ^ 0xff
  const webpTrailing = cat(riff([vp8()]), polyglotTail)

  it.each([
    ['an empty body', new Uint8Array(0), 'image/png', 'empty'],
    ['SVG declared as PNG', svg, 'image/png', 'unsupported_format'],
    ['SVG as itself', svg, 'image/svg+xml', 'unsupported_format'],
    ['GIF', gif, 'image/png', 'unsupported_format'],
    ['HTML', html, 'image/jpeg', 'unsupported_format'],
    ['APNG (acTL)', apng, 'image/png', 'animated'],
    ['APNG (fcTL)', apngFrame, 'image/png', 'animated'],
    ['animated WebP', animatedWebp, 'image/webp', 'animated'],
    ['WebP with the animation flag', animFlagOnly, 'image/webp', 'animated'],
    ['WebP with an animation frame', anmfWithoutFlag, 'image/webp', 'animated'],
    ['a truncated PNG', goodPng.subarray(0, goodPng.length - 12), 'image/png', 'malformed'],
    ['a PNG cut inside a chunk', goodPng.subarray(0, 40), 'image/png', 'malformed'],
    ['a PNG with a wrong CRC', badCrc, 'image/png', 'malformed'],
    [
      'a PNG without IDAT',
      cat(
        PNG_SIG,
        pngChunk('IHDR', [...be32(64), ...be32(64), 8, 2, 0, 0, 0]),
        pngChunk('IEND', []),
      ),
      'image/png',
      'malformed',
    ],
    [
      'a PNG with an unknown critical chunk',
      png(64, 64, [pngChunk('ABCD', [1])]),
      'image/png',
      'malformed',
    ],
    ['a PNG with an invalid bit depth', png(64, 64, [], { depth: 3 }), 'image/png', 'malformed'],
    ['a JPEG without EOI', jpeg(64, 64, { eoi: false }), 'image/jpeg', 'malformed'],
    ['a JPEG cut in the header', jpeg().subarray(0, 30), 'image/jpeg', 'malformed'],
    ['a lossless JPEG (SOF3)', jpeg(64, 64, { sof: 0xc3 }), 'image/jpeg', 'unsupported_format'],
    ['an arithmetic JPEG (SOF9)', jpeg(64, 64, { sof: 0xc9 }), 'image/jpeg', 'unsupported_format'],
    ['a truncated WebP', riff([vp8()]).subarray(0, 30), 'image/webp', 'malformed'],
    [
      'a WebP with a canvas other than its image',
      riff([vp8x(64, 64), vp8l(65, 64)]),
      'image/webp',
      'malformed',
    ],
    [
      'a WebP with an unknown chunk',
      riff([vp8(), webpChunk('ABCD', [1, 2])]),
      'image/webp',
      'malformed',
    ],
    ['a WebP with two images', riff([vp8(), vp8()]), 'image/webp', 'malformed'],
    ['a PNG declared as JPEG', goodPng, 'image/jpeg', 'type_mismatch'],
    ['a JPEG declared as WebP', jpeg(), 'image/webp', 'type_mismatch'],
    ['a WebP declared as PNG', riff([vp8()]), 'image/png', 'type_mismatch'],
    ['a PNG of 16 pixels', png(16, 16), 'image/png', 'dimensions'],
    ['a PNG of 2048 pixels', png(2048, 64), 'image/png', 'dimensions'],
    ['a JPEG of 2000 pixels', jpeg(64, 2000), 'image/jpeg', 'dimensions'],
    ['a JPEG of height 0', jpeg(64, 0), 'image/jpeg', 'dimensions'],
    ['a WebP of 4000 pixels', riff([vp8l(4000, 64)]), 'image/webp', 'dimensions'],
    ['a PNG with an HTML tail', cat(goodPng, polyglotTail), 'image/png', 'trailing_data'],
    [
      'a JPEG with an appended archive',
      cat(jpeg(), ascii('PK'), [3, 4], new Uint8Array(40)),
      'image/jpeg',
      'trailing_data',
    ],
    ['a JPEG with a second JPEG appended', cat(jpeg(), jpeg()), 'image/jpeg', 'trailing_data'],
    ['a WebP with data beyond its RIFF size', webpTrailing, 'image/webp', 'trailing_data'],
    ['more than 256 KiB', cat(goodPng, new Uint8Array(256 * 1024)), 'image/png', 'too_large'],
  ] as const)('%s', (_name, bytes, type, reason) => {
    expect(checkAvatarImage(bytes, type)).toEqual({ ok: false, reason })
  })
})
