import { afterEach, describe, expect, it } from 'vitest'
import { secretExposure } from './secret-scan.ts'

const SECRET = `exak_${'S'.repeat(43)}`

afterEach(() => {
  document.body.innerHTML = ''
  document.title = ''
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('the scan for a reveal-once secret', () => {
  it('accepts the secret in the one allowed element and nowhere else', () => {
    document.body.innerHTML = `<main><code id="once">${SECRET}</code><p>Shown once.</p></main>`
    expect(secretExposure(document.body, SECRET, '#once')).toEqual([])
  })

  it('finds it in a title, a data attribute, an aria label, a value, a comment and other text', () => {
    document.body.innerHTML = [
      `<code id="once">${SECRET}</code>`,
      `<button title="${SECRET}">a</button>`,
      `<div data-copy="${SECRET}"></div>`,
      `<span aria-label="key ${SECRET}"></span>`,
      `<input value="${SECRET}">`,
      `<!-- ${SECRET} -->`,
      `<p>${SECRET}</p>`,
    ].join('')
    const input = document.querySelector('input')
    if (input !== null) input.value = SECRET
    expect(secretExposure(document.body, SECRET, '#once').sort()).toEqual(
      [
        '<button title>',
        '<div data-copy>',
        '<span aria-label>',
        '<input value>',
        '<input>.value',
        'comment node',
        'text outside #once',
      ].sort(),
    )
  })

  it('finds it in the title, the storages and the address', () => {
    document.title = SECRET
    window.localStorage.setItem('k', SECRET)
    window.sessionStorage.setItem(SECRET, 'v')
    window.history.replaceState(null, '', `/x?${SECRET}`)
    expect(secretExposure(document.body, SECRET, '#once').sort()).toEqual([
      'document.title',
      'localStorage',
      'location',
      'sessionStorage',
    ])
    window.history.replaceState(null, '', '/')
  })

  it('treats the element that is gone as nothing allowed: any text left is an exposure', () => {
    document.body.innerHTML = `<p>${SECRET}</p>`
    expect(secretExposure(document.body, SECRET, '#once')).toEqual(['text outside #once'])
  })
})
