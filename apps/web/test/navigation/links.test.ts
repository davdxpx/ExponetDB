import { describe, expect, it } from 'vitest'
import {
  AUTHORIZE_ERROR_FALLBACK,
  AUTHORIZE_ERRORS,
  authorizeError,
  credentialTarget,
  DEFAULT_RETURN,
  groupSecret,
  linkToken,
  loginUrl,
  operationOf,
  qrPath,
  requestHandle,
  SCHEMA_KINDS,
  safeReturnTo,
  stepUpOf,
  TARGET_SECTIONS,
} from '../../src/lib/navigation/links.ts'

const OP = 'op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
const PLAN = 'pln_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
const CLUSTER = 'cls_01M4QT02MQ05WZ8J29C134Y45A'
const TOKEN = 'A'.repeat(43)

describe('returnTo (no open redirect): the Wave 3A cases', () => {
  it('accepts the account and approvals pages of this origin', () => {
    expect(safeReturnTo('/account')).toBe('/account')
    expect(safeReturnTo('/approvals')).toBe('/approvals')
    expect(safeReturnTo(`/approvals#operation=${OP}`)).toBe(`/approvals#operation=${OP}`)
  })

  it('accepts the consent page with a request handle, device entry and administration pages', () => {
    expect(safeReturnTo(`/oauth/consent#request=exar_${TOKEN}`)).toBe(
      `/oauth/consent#request=exar_${TOKEN}`,
    )
    expect(safeReturnTo('/oauth/device')).toBe('/oauth/device')
    expect(safeReturnTo('/admin/clients')).toBe('/admin/clients')
    expect(safeReturnTo('/admin/service-accounts')).toBe('/admin/service-accounts')
    expect(safeReturnTo('/step-up#id=stu_01M4QT02MQ05WZ8J29C134Y45A')).toBe(
      '/step-up#id=stu_01M4QT02MQ05WZ8J29C134Y45A',
    )
    expect(safeReturnTo('/step-up#id=evil')).toBe(DEFAULT_RETURN)
    expect(safeReturnTo('/step-up')).toBe(DEFAULT_RETURN)
    expect(safeReturnTo(`/credentials#cluster=${CLUSTER}&role=observer`)).toBe(
      `/credentials#cluster=${CLUSTER}&role=observer`,
    )
    expect(safeReturnTo(`/credentials#cluster=${CLUSTER}`)).toBe(`/credentials#cluster=${CLUSTER}`)
    expect(safeReturnTo(`/credentials#cluster=${CLUSTER}&role=superuser`)).toBe(DEFAULT_RETURN)
    expect(safeReturnTo(`/credentials#cluster=${CLUSTER}&role=observer&password=x`)).toBe(
      DEFAULT_RETURN,
    )
  })

  it('falls back for everything else', () => {
    for (const hostile of [
      null,
      undefined,
      '',
      'https://evil.example/account',
      '//evil.example/account',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      '/account?x=1',
      '/account#x',
      '/approvals#operation=op_short',
      `/approvals#operation=${OP}&x`,
      '/login',
      '/setup',
      '/%2F%2Fevil.example',
      ' /account',
      '/account/',
      '/ACCOUNT',
      '/oauth/consent',
      `/oauth/consent#request=exar_${TOKEN}x`,
      `/oauth/consent#request=exar_${TOKEN}&x=1`,
      `/oauth/consent#request=exat_${TOKEN}`,
      `/oauth/consent?request=exar_${TOKEN}`,
      '/oauth/device#code=BCDF-GHJK',
      '/oauth/device?user_code=BCDF-GHJK',
      '/oauth/error',
      '/oauth/authorize',
      '/admin/clients#x',
      '/admin/clients/',
      '/admin',
    ]) {
      expect(safeReturnTo(hostile), String(hostile)).toBe(DEFAULT_RETURN)
    }
  })

  it('builds the sign-in URL with an encoded safe target only', () => {
    expect(loginUrl('/account')).toBe('/login')
    expect(loginUrl(`/approvals#operation=${OP}`)).toBe(
      `/login?returnTo=${encodeURIComponent(`/approvals#operation=${OP}`)}`,
    )
    expect(loginUrl('https://evil.example')).toBe('/login')
  })
})

describe('returnTo: the Wave 8 pages, by whole-path grammar', () => {
  it('accepts every global page and every target section', () => {
    for (const path of [
      '/',
      '/targets',
      '/changes',
      `/changes/plans/${PLAN}`,
      `/changes/operations/${OP}`,
      '/infrastructure/servers',
      '/infrastructure/clusters',
      '/infrastructure/nodes',
      '/infrastructure/certificates',
      `/infrastructure/clusters/${CLUSTER}`,
      '/infrastructure/nodes/nod_01M4QT02MQ05WZ8J29C134Y45A',
      '/infrastructure/servers/srv_01M4QT02MQ05WZ8J29C134Y45A',
      '/backups',
      '/access/people',
      '/access/roles',
      '/access/service-accounts',
      '/access/api-keys',
      '/access/oauth-clients',
      '/access/connected-apps',
      '/audit',
      '/settings/products',
      '/settings/installation',
      '/connect',
      '/t/reosa/platform/production',
      ...TARGET_SECTIONS.map((s) => `/t/reosa/platform/staging/${s}`),
      ...SCHEMA_KINDS.map((k) => `/t/shop/app-1/dev/schema/${k}`),
    ]) {
      expect(safeReturnTo(path), path).toBe(path)
    }
  })

  it('refuses near misses: wrong ids, names, sections, depth, case and encodings', () => {
    for (const hostile of [
      '/changes/',
      '/changes/plans',
      '/changes/plans/pln_short',
      `/changes/plans/${PLAN.toLowerCase()}`,
      `/changes/plans/${OP}`,
      `/changes/plans/${PLAN}/apply`,
      `/changes/plans/${PLAN}?apply=1`,
      `/changes/plans/${PLAN}#x`,
      `/infrastructure/clusters/srv_01M4QT02MQ05WZ8J29C134Y45A`,
      '/infrastructure',
      '/infrastructure/disks',
      '/access/tokens',
      '/settings',
      '/settings/secrets',
      '/t',
      '/t/reosa',
      '/t/reosa/platform',
      '/t/reosa/platform/production/',
      '/t/Reosa/platform/production',
      '/t/reosa/platform/production/terminal',
      '/t/reosa/platform/production/schema/tables/public.users',
      '/t/reosa/platform/production/schema/tables/',
      '/t/reosa/platform/production/sql?sql=DROP%20TABLE%20x',
      '/t/reosa/platform/production/sql#sql=x',
      '/t/re%2Fosa/platform/production',
      '/t/reosa/../production',
      '/t/1abc/platform/production',
      `/t/${'a'.repeat(40)}/platform/production`,
      '/t/reosa/platform/production\n',
      '/t/reosa/platform/production ',
      '//t/reosa/platform/production',
      '/connect/',
    ]) {
      expect(safeReturnTo(hostile), JSON.stringify(hostile)).toBe(DEFAULT_RETURN)
    }
  })
})

describe('fragments', () => {
  it('reads an approval operation, a step-up id and a credential link in their exact form only', () => {
    expect(operationOf(`#operation=${OP}`)).toBe(OP)
    expect(operationOf(`#operation=${OP}&x=1`)).toBeUndefined()
    expect(operationOf('#operation=op_x')).toBeUndefined()
    expect(stepUpOf('#id=stu_01M4QT02MQ05WZ8J29C134Y45A')).toBe('stu_01M4QT02MQ05WZ8J29C134Y45A')
    expect(stepUpOf('#id=stu_x')).toBeUndefined()
    expect(credentialTarget(`#cluster=${CLUSTER}&role=migrator`)).toEqual({
      cluster: CLUSTER,
      role: 'migrator',
    })
    expect(credentialTarget(`#cluster=${CLUSTER}`)).toEqual({ cluster: CLUSTER, role: undefined })
    expect(credentialTarget('#cluster=cls_x&role=migrator')).toBeUndefined()
    expect(credentialTarget(`#role=migrator&cluster=${CLUSTER}`)).toBeUndefined()
  })

  it('accepts the one-time token kind of the page only', () => {
    expect(linkToken('/setup', `#token=exsu_${TOKEN}`)).toBe(`exsu_${TOKEN}`)
    expect(linkToken('/invite', `#token=exiv_${TOKEN}`)).toBe(`exiv_${TOKEN}`)
    expect(linkToken('/recover', `#token=exrc_${TOKEN}`)).toBe(`exrc_${TOKEN}`)
    expect(linkToken('/setup', `#token=exiv_${TOKEN}`)).toBeUndefined()
    expect(linkToken('/invite', `#token=exrc_${TOKEN}`)).toBeUndefined()
    expect(linkToken('/setup', '')).toBeUndefined()
    expect(linkToken('/setup', `#token=exsu_${TOKEN}x`)).toBeUndefined()
    expect(linkToken('/setup', `#token=exsu_${TOKEN}&a=b`)).toBeUndefined()
    expect(linkToken('/setup', `?token=exsu_${TOKEN}`)).toBeUndefined()
  })

  it('takes the request handle from the fragment only in its exact form', () => {
    expect(requestHandle(`#request=exar_${TOKEN}`)).toBe(`exar_${TOKEN}`)
    for (const hostile of [
      '',
      `#request=exar_${TOKEN}x`,
      `#request=exar_${TOKEN}&a=b`,
      `#request=exac_${TOKEN}`,
      `?request=exar_${TOKEN}`,
      `#request=exar_${'<'.repeat(43)}`,
    ]) {
      expect(requestHandle(hostile), hostile).toBeUndefined()
    }
  })
})

describe('the authorization error page', () => {
  it('shows fixed text and never echoes the query', () => {
    expect(authorizeError('?reason=client_unknown')).toBe(AUTHORIZE_ERRORS.client_unknown)
    expect(authorizeError('?reason=redirect_uri_invalid')).toBe(
      AUTHORIZE_ERRORS.redirect_uri_invalid,
    )
    for (const hostile of ['', '?reason=<script>', '?reason=toString', '?reason=__proto__']) {
      expect(authorizeError(hostile), hostile).toBe(AUTHORIZE_ERROR_FALLBACK)
    }
  })
})

describe('QR and secrets', () => {
  it('draws dark modules only, offset by the quiet zone', () => {
    expect(qrPath(['10', '01'])).toBe('M4 4h1v1h-1zM5 5h1v1h-1z')
    expect(qrPath(['00'])).toBe('')
  })

  it('groups the TOTP secret for reading', () => {
    expect(groupSecret('ABCDEFGHIJ')).toBe('ABCD EFGH IJ')
  })
})
