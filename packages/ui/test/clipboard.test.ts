import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyToClipboard } from '../src/lib/clipboard.ts'

type ClipboardStub = {
  write?: ReturnType<typeof vi.fn>
  writeText?: ReturnType<typeof vi.fn>
}

function installClipboard(stub: ClipboardStub | undefined) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub })
}

class ClipboardItemStub {
  readonly items: Record<string, Promise<Blob>>
  constructor(items: Record<string, Promise<Blob>>) {
    this.items = items
  }
}

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.stubGlobal('ClipboardItem', ClipboardItemStub)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    installClipboard(undefined)
  })

  it('writes a known string with writeText', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard({ write, writeText })

    await expect(copyToClipboard('sha256:abc')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('sha256:abc')
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps a promised string inside the ClipboardItem so Safari accepts the write', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    installClipboard({ write })

    await expect(copyToClipboard(Promise.resolve('loaded later'))).resolves.toBe(true)

    const item = write.mock.calls[0]?.[0][0] as ClipboardItemStub
    expect(await (await item.items['text/plain'])?.text()).toBe('loaded later')
  })

  it('falls back to writeText when the promised item is refused', async () => {
    const write = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard({ write, writeText })

    await expect(copyToClipboard(Promise.resolve('fallback'))).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('fallback')
  })

  it('uses writeText when there is no ClipboardItem', async () => {
    vi.stubGlobal('ClipboardItem', undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard({ writeText })

    await expect(copyToClipboard(Promise.resolve('text'))).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('text')
  })

  it('resolves false, and shows nothing, when the document has no focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const writeText = vi.fn()
    installClipboard({ writeText })

    await expect(copyToClipboard('x')).resolves.toBe(false)

    expect(writeText).not.toHaveBeenCalled()
    expect(document.body.textContent).toBe('')
  })

  it('resolves false when there is no Clipboard API', async () => {
    installClipboard(undefined)

    await expect(copyToClipboard('x')).resolves.toBe(false)
  })

  it('resolves false when every write is refused', async () => {
    installClipboard({
      write: vi.fn().mockRejectedValue(new Error('denied')),
      writeText: vi.fn().mockRejectedValue(new Error('denied')),
    })

    await expect(copyToClipboard('x')).resolves.toBe(false)
  })

  it('resolves false instead of rejecting when the promised text fails', async () => {
    installClipboard({
      write: vi.fn().mockImplementation(async ([item]: ClipboardItemStub[]) => {
        await item?.items['text/plain']
      }),
      writeText: vi.fn().mockResolvedValue(undefined),
    })

    await expect(copyToClipboard(Promise.reject(new Error('expired link')))).resolves.toBe(false)
  })
})
