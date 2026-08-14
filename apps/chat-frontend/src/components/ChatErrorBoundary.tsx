import { Component, type ErrorInfo, type ReactNode } from 'react'
import { brand } from '../lib/brand'

// Defense-in-depth for the chat surface. A render-time throw anywhere in the
// chat tree (the assistant-ui runtime, the Thread, a message renderer) would
// otherwise propagate to the root and blank the entire SPA — there is no other
// boundary. This catches it and shows a recoverable card instead.
//
// The concrete bug that motivated this: resuming an agent thread whose history
// had duplicate message ids made assistant-ui's MessageRepository throw during
// render, white-screening the app on every thread click (fixed at the source in
// linesToUIMessages, but a future render throw shouldn't take the whole app
// down either).
//
// `resetKey` (the active thread id) clears a prior error when the user switches
// threads, so a single bad thread doesn't strand the surface forever.

interface Props {
  children: ReactNode
  resetKey: string
  onReset: () => void
}

interface State {
  error: Error | null
}

export class ChatErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it for debugging / any error-reporting that hooks console.
    console.error('[ChatErrorBoundary] chat surface crashed:', error, info.componentStack)
  }

  componentDidUpdate(prev: Props): void {
    // Switching threads (or toggling agent mode, which also remints the id)
    // clears the error so the surface can recover without a full reload.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <main className="flex min-h-screen items-center justify-center bg-t-deep t-bg-pattern px-4">
        <div className="t-card w-full max-w-md p-8 text-center">
          <div className="mb-3 inline-block px-3 py-1 text-[10px] font-display uppercase tracking-[0.2em] text-t-accent border border-t-accent/40 rounded">
            {brand.name}
          </div>
          <h1 className="mb-2 font-display text-2xl font-semibold text-t-bright">
            This chat hit a snag
          </h1>
          <p className="mb-6 text-sm text-t-muted">
            Something went wrong rendering this conversation. Your other chats are
            fine — start a fresh one, or reload the app.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => {
                this.props.onReset()
                this.setState({ error: null })
              }}
              className="inline-flex items-center justify-center gap-2 rounded border border-t-accent/50 bg-t-accent/10 px-4 py-2 text-sm font-medium text-t-bright transition-colors hover:border-t-accent hover:bg-t-accent/20"
            >
              Start a fresh chat
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center gap-2 rounded border border-t-border bg-t-surface px-4 py-2 text-sm font-medium text-t-bright transition-colors hover:border-t-border-active hover:bg-t-hover"
            >
              Reload
            </button>
          </div>
        </div>
      </main>
    )
  }
}
