// Phase 0.B.4 — One-time onboarding gate. Renders before <ChatPage /> when
// the controller reports the user has no Google OAuth tokens stored. The
// scopes we list here mirror SCOPES in controller/src/routes/oauth.ts:
// drive.readonly, gmail.modify, calendar (+ openid/email which aren't
// surfaced to the user).
//
// "Connect Google" navigates the whole tab to the controller's /start
// route — we leave the SPA, hop through Google consent, and land back at
// /chat/ where the status probe re-runs and clears the gate.
//
// "Skip for now" is a sessionStorage-only escape hatch for development /
// operator testing where existing gccli accounts.json works. The flag
// clears on tab close — there's no persistent bypass.

import { useGoogleOAuth, buildOAuthStartUrl } from '../lib/google-oauth'

export function ConnectGoogleScreen() {
  const { skipForSession } = useGoogleOAuth()

  const onConnect = () => {
    window.location.href = buildOAuthStartUrl()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-t-deep t-bg-pattern px-4">
      <div className="t-card w-full max-w-md p-8">
        <div className="mb-3 inline-block px-3 py-1 text-[10px] font-display uppercase tracking-[0.2em] text-t-accent border border-t-accent/40 rounded">
          Omega
        </div>
        <h1 className="mb-3 font-display text-2xl font-semibold text-t-bright">
          Connect your Google account
        </h1>
        <p className="mb-4 text-sm text-t-muted">
          The assistant works against your Google workspace — it reads your Drive
          Personal Knowledge Center for context, sends and triages mail through
          Gmail, and reads and writes events on your Calendar. Connecting once
          lets the agent do its job without prompting again.
        </p>

        <ul className="mb-6 space-y-2 text-sm text-t-muted">
          <li className="flex gap-2">
            <span aria-hidden className="text-t-accent">·</span>
            <span>
              <span className="text-t-bright">Read your Google Drive</span> (read-only)
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="text-t-accent">·</span>
            <span>
              <span className="text-t-bright">Read and modify your Gmail</span>
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="text-t-accent">·</span>
            <span>
              <span className="text-t-bright">Read and modify your Google Calendar</span>
            </span>
          </li>
        </ul>

        <button
          type="button"
          onClick={onConnect}
          className="inline-flex w-full items-center justify-center gap-2 rounded border border-t-accent bg-t-accent/10 px-4 py-2 text-sm font-medium text-t-bright transition-colors hover:bg-t-accent/20"
        >
          Connect Google
        </button>

        <button
          type="button"
          onClick={skipForSession}
          className="mt-3 block w-full text-center text-xs uppercase tracking-wider text-t-muted underline-offset-2 hover:text-t-bright hover:underline"
        >
          Skip for now
        </button>
        <p className="mt-2 text-center text-[10px] text-t-muted/70">
          Skipping is session-only — the prompt returns when you reopen this tab.
        </p>
      </div>
    </main>
  )
}

export function GoogleStatusLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-t-deep">
      <span className="text-xs font-terminal uppercase tracking-wider text-t-muted">
        Checking Google connection…
      </span>
    </main>
  )
}

export function GoogleStatusError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-t-deep t-bg-pattern px-4">
      <div className="t-card w-full max-w-sm p-8 text-center">
        <h1 className="mb-2 font-display text-2xl font-semibold text-t-bright">
          Connection check failed
        </h1>
        <p className="mb-6 text-sm text-t-muted">
          We couldn't reach the controller to check your Google connection
          ({message}). Without it the assistant will hit confusing 401s on
          Drive / Gmail / Calendar requests.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex w-full items-center justify-center gap-2 rounded border border-t-border bg-t-surface px-4 py-2 text-sm font-medium text-t-bright transition-colors hover:border-t-border-active hover:bg-t-hover"
        >
          Retry
        </button>
      </div>
    </main>
  )
}
