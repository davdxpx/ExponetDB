import '@testing-library/jest-dom/vitest'
import { Button } from '@exponetdb/ui'
import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrorDisplay } from '../../src/error-display/error-display.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('ErrorDisplay', () => {
  it('is an alert named by its title, with the reason and the stable code', () => {
    render(
      <ErrorDisplay
        title="Could not read schema"
        message="The target did not answer."
        code="TARGET_UNREACHABLE"
      />,
    )

    const alert = screen.getByRole('alert', { name: 'Could not read schema' })
    expect(alert).toHaveTextContent('The target did not answer.')
    expect(alert).toHaveTextContent('Error code TARGET_UNREACHABLE')
  })

  it('shows the reason as text, never as markup', () => {
    const { container } = render(
      <ErrorDisplay title="Failed" message="<img src=x onerror=alert(1)> <script>x</script>" />,
    )

    expect(container.querySelector('img, script')).toBeNull()
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>')
  })

  it('renders the actions and the notes the caller gives', () => {
    render(
      <ErrorDisplay title="Failed" message="Reason" actions={<Button>Try again</Button>}>
        <p>Check the node.</p>
      </ErrorDisplay>,
    )

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.getByText('Check the node.')).toBeInTheDocument()
  })

  it('has no support link, support URL or hard-coded id of its source', () => {
    const { container } = render(<ErrorDisplay title="Failed" message="Reason" code="X" />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(container.querySelector('#error-display-title')).toBeNull()
    expect(container).not.toHaveTextContent(/support/i)
  })

  it('names each alert by its own title when several are on the page', () => {
    render(
      <>
        <ErrorDisplay title="First failure" message="a" />
        <ErrorDisplay title="Second failure" message="b" />
      </>,
    )

    expect(screen.getByRole('alert', { name: 'First failure' })).toBeInTheDocument()
    expect(screen.getByRole('alert', { name: 'Second failure' })).toBeInTheDocument()
  })

  it('uses the heading level it is given and forwards its ref', () => {
    const ref = createRef<HTMLDivElement>()
    render(<ErrorDisplay ref={ref} title="Failed" message="Reason" headingLevel={2} />)

    expect(screen.getByRole('heading', { level: 2, name: 'Failed' })).toBeInTheDocument()
    expect(ref.current).toBe(screen.getByRole('alert'))
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ErrorDisplay
        title="Could not read schema"
        message="The target did not answer."
        code="TARGET_UNREACHABLE"
        actions={<Button>Try again</Button>}
      />,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
