import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  avatarSrcOf,
  checkAvatarFile,
  initialsOf,
  refusalOf,
} from '../../src/features/account/profile-model.ts'
import { ApiError } from '../../src/lib/api/errors.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { FakeServer, ids, json, meOf, mountApp, problem } from './support.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const SHA = `sha256:${'a'.repeat(64)}`
const AVATAR_URL = `/api/v1/identities/${ids.identity}/avatar?v=${SHA}`
const AVATAR = { url: AVATAR_URL, sha256: SHA, width: 64, height: 64 }

function me(over: Record<string, unknown> = {}) {
  return { ...meOf(), displayName: 'Grace Hopper', avatar: null, profileRevision: 3, ...over }
}

function profileServer(over: Record<string, unknown> = {}): FakeServer {
  return new FakeServer().signedIn(me(over))
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])

function file(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes as BlobPart], name, { type })
}

function bytesOf(blob: unknown): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)])
    reader.onerror = () => reject(new Error('unreadable'))
    reader.readAsArrayBuffer(blob as Blob)
  })
}

async function profileReady(): Promise<void> {
  await waitFor(() => expect(document.querySelector('#profile-name-form')).not.toBeNull())
}

describe('the profile model', () => {
  it('takes initials from letters and digits of the first two words, never hidden characters', () => {
    expect(initialsOf('Grace Hopper')).toBe('GH')
    expect(initialsOf('ada')).toBe('A')
    expect(initialsOf('owner@example.test')).toBe('O')
    expect(initialsOf('ada.lovelace@example.test')).toBe('AL')
    expect(initialsOf('‮​ évil name')).toBe('ÉN')
    expect(initialsOf('<script>')).toBe('S')
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('‮​')).toBe('?')
  })

  it('accepts only the server-named same-origin path as a picture address', () => {
    expect(avatarSrcOf(AVATAR)).toBe(AVATAR_URL)
    expect(avatarSrcOf(null)).toBeUndefined()
    for (const hostile of [
      'https://evil.example/a.png',
      '//evil.example/a.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      `/api/v1/identities/${ids.identity}/avatar`,
      `${AVATAR_URL}&x=1`,
      `https://evil.example${AVATAR_URL}`,
      '/api/v1/identities/../avatar',
    ]) {
      expect(avatarSrcOf({ ...AVATAR, url: hostile }), hostile).toBeUndefined()
    }
  })

  it('refuses a wrong type, an empty file and more than 256 KiB before sending', () => {
    expect(checkAvatarFile({ type: 'image/png', size: 10 })).toBeUndefined()
    expect(checkAvatarFile({ type: 'image/jpeg', size: 256 * 1024 })).toBeUndefined()
    expect(checkAvatarFile({ type: 'image/webp', size: 1 })).toBeUndefined()
    expect(checkAvatarFile({ type: 'image/svg+xml', size: 10 })).toBe('unsupported_format')
    expect(checkAvatarFile({ type: 'image/gif', size: 10 })).toBe('unsupported_format')
    expect(checkAvatarFile({ type: '', size: 10 })).toBe('unsupported_format')
    expect(checkAvatarFile({ type: 'image/png', size: 0 })).toBe('empty')
    expect(checkAvatarFile({ type: 'image/png', size: 256 * 1024 + 1 })).toBe('too_large')
  })

  it('reads the refusal reason of a 422 and falls back to a fixed sentence', () => {
    const refused = (code: string) =>
      new ApiError('VALIDATION_FAILED', 422, 'x', undefined, { errors: [{ path: '/body', code }] })
    expect(refusalOf(refused('animated'))).toBe(en['profile.picture.reason.animated'])
    expect(refusalOf(refused('something_new'))).toBe(en['profile.picture.reason.unknown'])
    expect(refusalOf(new ApiError('INTERNAL', 500, 'x'))).toBeUndefined()
    expect(refusalOf(new Error('x'))).toBeUndefined()
  })
})

describe('the profile tab', () => {
  it('shows the initials in a tile when there is no picture, and no image', async () => {
    mountApp('/account', profileServer())
    await profileReady()
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(document.querySelector('#avatar-state')?.textContent).toBe(en['profile.picture.none'])
    expect(document.querySelector('[data-slot="profile-avatar"]')?.textContent).toBe('GH')
    expect(screen.queryByRole('button', { name: en['profile.picture.remove'] })).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('shows the picture from the same-origin address with an empty alt', async () => {
    mountApp('/account', profileServer({ avatar: AVATAR }))
    await profileReady()
    const img = document.querySelector('img')
    expect(img?.getAttribute('src')).toBe(AVATAR_URL)
    expect(img?.getAttribute('alt')).toBe('')
    expect(screen.getByRole('button', { name: en['profile.picture.remove'] })).toBeVisible()
    expect(await axeViolations()).toEqual([])
  })

  it('never loads a picture from any address but the server path', async () => {
    mountApp(
      '/account',
      profileServer({ avatar: { ...AVATAR, url: 'https://evil.example/a.png' } }),
    )
    await profileReady()
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain('evil.example')
  })

  it('shows a hostile display name as text with visible code points', async () => {
    const hostile = 'Eve ‮​<script>alert(1)</script>'
    mountApp('/account', profileServer({ displayName: hostile }))
    await waitFor(() => expect(document.querySelector('#me-email')).not.toBeNull())
    expect(document.body.textContent).toContain('⟨U+202E⟩')
    expect(document.body.textContent).toContain('⟨U+200B⟩')
    expect(document.body.textContent).toContain('<script>alert(1)</script>')
    expect(document.querySelectorAll('script')).toHaveLength(0)
    expect(await axeViolations()).toEqual([])
  })

  it('keeps every id the browser suites use on the tabs they were on', async () => {
    mountApp('/account', profileServer())
    await waitFor(() => expect(document.querySelector('#me-email')).not.toBeNull())
    expect(document.querySelector('#me-roles')).not.toBeNull()
  })

  it('saves the display name at the revision it read', async () => {
    const fake = profileServer().on('PUT', '/api/v1/me/profile', () =>
      json(200, {
        identityId: ids.identity,
        displayName: 'Grace B. Hopper',
        avatar: null,
        revision: 4,
        updatedAt: null,
      }),
    )
    mountApp('/account', fake)
    await profileReady()
    const user = userEvent.setup()
    const input = screen.getByLabelText(en['profile.name.label'])
    await user.clear(input)
    await user.type(input, '  Grace B. Hopper ')
    await user.click(screen.getByRole('button', { name: en['profile.name.save'] }))
    await waitFor(() =>
      expect(document.querySelector('.status')?.textContent).toBe(en['profile.name.saved']),
    )
    const sent = fake.to('PUT', '/api/v1/me/profile')[0]
    expect(sent?.body).toEqual({ displayName: 'Grace B. Hopper', revision: 3 })
    expect(sent?.headers['x-csrf-token']).toBe('csrf-token')
  })

  it('clears the display name with null, and refuses more than 64 characters without a request', async () => {
    const fake = profileServer().answer('PUT', '/api/v1/me/profile', 200, {
      identityId: ids.identity,
      displayName: null,
      avatar: null,
      revision: 4,
      updatedAt: null,
    })
    mountApp('/account', fake)
    await profileReady()
    const user = userEvent.setup()
    const input = screen.getByLabelText(en['profile.name.label'])
    await user.clear(input)
    await user.type(input, 'x'.repeat(65))
    await user.click(screen.getByRole('button', { name: en['profile.name.save'] }))
    expect(document.querySelector('.alert')?.textContent).toBe(en['profile.name.tooLong'])
    expect(fake.to('PUT', '/api/v1/me/profile')).toHaveLength(0)
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: en['profile.name.save'] }))
    await waitFor(() =>
      expect(document.querySelector('.status')?.textContent).toBe(en['profile.name.cleared']),
    )
    expect(fake.to('PUT', '/api/v1/me/profile')[0]?.body).toEqual({
      displayName: null,
      revision: 3,
    })
  })

  it('says the profile changed elsewhere on a 409 and reads it again', async () => {
    const fake = profileServer().on('PUT', '/api/v1/me/profile', () =>
      problem(409, 'CONFLICT', 'The profile changed.'),
    )
    mountApp('/account', fake)
    await profileReady()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: en['profile.name.save'] }))
    await waitFor(() =>
      expect(document.querySelector('.alert')?.textContent).toBe(en['profile.name.conflict']),
    )
    await waitFor(() => expect(fake.to('GET', '/api/v1/me').length).toBeGreaterThan(1))
  })

  it('sends the exact bytes with the exact content type and the CSRF header, never an Authorization header', async () => {
    const fake = profileServer().on('PUT', '/api/v1/me/avatar', () =>
      json(200, {
        identityId: ids.identity,
        displayName: 'Grace Hopper',
        avatar: AVATAR,
        revision: 4,
        updatedAt: null,
      }),
    )
    mountApp('/account', fake)
    await profileReady()
    const user = userEvent.setup()
    await user.upload(
      screen.getByLabelText(en['profile.picture.label']),
      file(PNG_BYTES, 'me.png', 'image/png'),
    )
    // The preview is a data: URL (the CSP allows no blob: images).
    await waitFor(() => expect(document.querySelector('img')).not.toBeNull())
    expect(document.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(screen.getByText(en['profile.picture.preview'])).toBeVisible()
    await user.click(screen.getByRole('button', { name: en['profile.picture.upload'] }))
    await waitFor(() =>
      expect(document.querySelector('.status')?.textContent).toBe(en['profile.picture.uploaded']),
    )
    const sent = fake.to('PUT', '/api/v1/me/avatar')
    expect(sent).toHaveLength(1)
    const request = sent[0]
    expect(request?.headers['content-type']).toBe('image/png')
    expect(request?.headers['x-csrf-token']).toBe('csrf-token')
    expect(Object.keys(request?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain(
      'authorization',
    )
    expect(await bytesOf(request?.raw)).toEqual([...PNG_BYTES])
  })

  it('refuses an SVG and an oversized file in the browser, without a request', async () => {
    const fake = profileServer()
    mountApp('/account', fake)
    await profileReady()
    const user = userEvent.setup({ applyAccept: false })
    const input = screen.getByLabelText(en['profile.picture.label'])
    await user.upload(
      input,
      file(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'x.svg',
        'image/svg+xml',
      ),
    )
    expect(document.querySelector('.alert')?.textContent).toBe(
      en['profile.picture.reason.unsupported_format'],
    )
    expect(screen.getByRole('button', { name: en['profile.picture.upload'] })).toBeDisabled()
    await user.upload(input, file(new Uint8Array(256 * 1024 + 1), 'big.png', 'image/png'))
    expect(document.querySelector('.alert')?.textContent).toBe(
      en['profile.picture.reason.too_large'],
    )
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0)
  })

  it.each([
    'unsupported_format',
    'type_mismatch',
    'malformed',
    'animated',
    'dimensions',
    'trailing_data',
    'too_large',
    'empty',
  ] as const)('shows the server reason %s as a sentence', async (code) => {
    const fake = profileServer().on('PUT', '/api/v1/me/avatar', () =>
      json(422, {
        code: 'VALIDATION_FAILED',
        message: 'The request is not valid.',
        details: { errors: [{ path: '/body', code }] },
      }),
    )
    mountApp('/account', fake)
    await profileReady()
    const user = userEvent.setup()
    await user.upload(
      screen.getByLabelText(en['profile.picture.label']),
      file(PNG_BYTES, 'me.png', 'image/png'),
    )
    await user.click(screen.getByRole('button', { name: en['profile.picture.upload'] }))
    await waitFor(() =>
      expect(document.querySelector('.alert')?.textContent).toBe(
        en[`profile.picture.reason.${code}`],
      ),
    )
    expect(document.querySelector('.alert')?.textContent).not.toContain('VALIDATION_FAILED')
  })

  it('removes the picture only after a confirmation', async () => {
    const fake = profileServer({ avatar: AVATAR }).on('DELETE', '/api/v1/me/avatar', () =>
      json(200, {
        identityId: ids.identity,
        displayName: 'Grace Hopper',
        avatar: null,
        revision: 4,
        updatedAt: null,
      }),
    )
    mountApp('/account', fake)
    await profileReady()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: en['profile.picture.remove'] }))
    const dialog = await screen.findByRole('alertdialog')
    expect(fake.to('DELETE', '/api/v1/me/avatar')).toHaveLength(0)
    await user.click(
      within(dialog).getByRole('button', { name: en['profile.picture.remove.action'] }),
    )
    await waitFor(() => expect(fake.to('DELETE', '/api/v1/me/avatar')).toHaveLength(1))
    expect(fake.to('DELETE', '/api/v1/me/avatar')[0]?.headers['x-csrf-token']).toBe('csrf-token')
    await waitFor(() =>
      expect(document.querySelector('.status')?.textContent).toBe(en['profile.picture.removed']),
    )
  })

  it('cancels the removal without a request', async () => {
    const fake = profileServer({ avatar: AVATAR })
    mountApp('/account', fake)
    await profileReady()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: en['profile.picture.remove'] }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(fake.to('DELETE', '/api/v1/me/avatar')).toHaveLength(0)
  })
})
