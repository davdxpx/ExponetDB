import type { Me } from '@exponetdb/contracts'
import { call } from './api.ts'
import { accountPage } from './pages/account.ts'
import { approvalsPage } from './pages/approvals.ts'
import { enrollmentPage } from './pages/enrollment.ts'
import { loginPage } from './pages/login.ts'
import { pageOf } from './safe.ts'
import { isSignedOut, shell, toLogin } from './shell.ts'

/** Entry point: one page per path; signed-in pages leave for sign-in when the session is gone. */
async function signedIn(): Promise<Me | undefined> {
  try {
    return await call<Me>('GET', '/api/v1/me')
  } catch (error) {
    if (isSignedOut(error)) {
      return undefined
    }
    throw error
  }
}

async function start(root: HTMLElement): Promise<void> {
  const page = pageOf(location.pathname) ?? '/'
  switch (page) {
    case '/setup':
      return enrollmentPage(shell(root, 'Set up ExponetDB', false), page)
    case '/invite':
      return enrollmentPage(shell(root, 'Accept invitation', false), page)
    case '/recover':
      return enrollmentPage(shell(root, 'Recover your account', false), page)
    case '/login': {
      if ((await signedIn()) !== undefined) {
        location.assign('/account')
        return
      }
      return loginPage(shell(root, 'Sign in', false))
    }
    case '/account':
    case '/approvals':
    case '/': {
      if ((await signedIn()) === undefined) {
        toLogin()
        return
      }
      if (page === '/approvals') {
        return approvalsPage(shell(root, 'Approvals', true))
      }
      if (page === '/') {
        history.replaceState(null, '', '/account')
      }
      return accountPage(shell(root, 'Your account', true))
    }
  }
}

const root = document.getElementById('app')
if (root !== null) {
  start(root).catch((error: unknown) => {
    shell(root, 'ExponetDB', false).alert(error)
  })
}
