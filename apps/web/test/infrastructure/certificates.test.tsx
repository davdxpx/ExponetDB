import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { BIDI, certificates, mountApp, NODE, TAG, World } from './support.tsx'

afterEach(cleanup)

const PATH = '/infrastructure/certificates'

describe('the certificates page', () => {
  it('lists authorities with validity, expiry warnings and fingerprints, and what is not known', async () => {
    const world = new World()
    const { container } = mountApp(PATH, world)
    const table = await screen.findByRole('table', { name: 'Certificate authorities' })
    expect(table.querySelector('[data-authority="root_ca"] [data-expiry="valid"]')).not.toBeNull()
    expect(table.querySelector('[data-authority="issuing_ca"] [data-expiry="soon"]')).not.toBeNull()
    expect(table.textContent).toContain(`sha256:${'a'.repeat(64)}`)
    expect(table.querySelector('code')).not.toBeNull()
    expect(
      screen.getByText('PostgreSQL CA: not initialized in the Control Store yet.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'The gateway’s TLS certificate: minted in memory for 72 hours and recorded nowhere.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/Server certificates of external clusters/)).toBeInTheDocument()
    const nodes = screen.getByRole('table', { name: 'Node certificates' })
    expect(nodes.querySelector(`[data-node="${NODE}"]`)).not.toBeNull()
    // No key material is ever on the page.
    expect(document.body.textContent).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE/)
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows an expired authority as expired', async () => {
    const world = new World()
    world.certs = certificates({
      authorities: [
        {
          role: 'gateway_server_ca',
          subjectCommonName: 'Gateway CA',
          notBefore: '2025-01-01T00:00:00Z',
          notAfter: '2026-01-01T00:00:00Z',
          fingerprint: `sha256:${'c'.repeat(64)}`,
        },
      ],
    })
    mountApp(PATH, world)
    const table = await screen.findByRole('table', { name: 'Certificate authorities' })
    expect(table.querySelector('[data-expiry="expired"]')?.textContent).toContain('Expired')
  })

  it('renders a hostile subject and local name as text', async () => {
    const world = new World()
    const base = certificates()
    const [authority] = base.authorities
    const [entry] = base.nodes
    if (authority === undefined || entry === undefined) throw new Error('no fixture')
    world.certs = certificates({
      authorities: [{ ...authority, subjectCommonName: `<b>CA</b>${BIDI}` }],
      nodes: [
        {
          ...entry,
          serverCertificates: [{ localName: `17/main${TAG}`, expiresAt: '2027-01-01T00:00:00Z' }],
        },
      ],
    })
    const { container } = mountApp(PATH, world)
    await screen.findByRole('table', { name: 'Certificate authorities' })
    expect(container.querySelector('b')).toBeNull()
    expect(document.body.textContent).toContain('<b>CA</b>⟨U+202E⟩')
    expect(document.body.textContent).not.toContain(BIDI)
    expect(document.body.textContent).not.toContain(TAG)
  })

  it('stays loading while the read runs', async () => {
    const world = new World()
    world.hang.add('GET /api/v1/nodes/certificates')
    mountApp(PATH, world)
    expect(await screen.findByText('Loading Certificates')).toBeInTheDocument()
    expect(screen.queryByText('Could not read Certificates')).toBeNull()
  })

  it('shows a failed read as failed, and a refused one with its permission', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/nodes/certificates', {
      status: 500,
      code: 'INTERNAL',
      message: 'Boom.',
    })
    mountApp(PATH, world)
    expect(await screen.findByText('Could not read Certificates')).toBeInTheDocument()
    cleanup()
    const refused = new World()
    refused.failures.set('GET /api/v1/nodes/certificates', {
      status: 403,
      code: 'PERMISSION_DENIED',
    })
    mountApp(PATH, refused)
    expect(await screen.findByText(/nodes\.read/)).toBeInTheDocument()
  })

  it('shows an old read as stale, from the time the server observed it', async () => {
    const world = new World()
    world.certs = certificates({ observedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
    mountApp(PATH, world)
    await waitFor(() =>
      expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
        /Showing an earlier read of Certificates/,
      ),
    )
  })

  it('says when nodes are missing from a partial answer', async () => {
    const world = new World()
    world.certs = certificates({ nodesTruncated: true })
    mountApp(PATH, world)
    expect(await screen.findByText('Nodes beyond the first 1000')).toBeInTheDocument()
  })
})
