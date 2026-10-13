import { AlertTriangle } from '@exponetdb/icons'
import { Button } from '@exponetdb/ui'
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Called with the error, so the app can report it. Its message is never shown. */
  onError?: ((error: Error) => void) | undefined
}

interface State {
  failed: boolean
}

/**
 * Keeps a failing page or command component from taking the whole app down. The
 * fallback names what failed and what to do next; it never shows the error.
 */
class CommandMenuErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-4 p-10">
        <AlertTriangle aria-hidden size={32} strokeWidth={1.5} />
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-base text-foreground">The command menu could not be shown.</p>
          <p className="text-sm text-foreground-lighter">
            Try again. If it keeps failing, close the menu and reload the page.
          </p>
        </div>
        <Button size="tiny" variant="secondary" onClick={() => this.setState({ failed: false })}>
          Try again
        </Button>
      </div>
    )
  }
}

export { CommandMenuErrorBoundary }
