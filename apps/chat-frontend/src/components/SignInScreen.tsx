// With Cloudflare Access, an unauthenticated user never reaches this app —
// CF intercepts and serves its own login page. The only time this screen
// actually renders is when:
//   (a) the dev bypass is off and the JWT got stripped somehow, or
//   (b) something is misconfigured.
// We render a hint + a reload button rather than our own sign-in flow.
export function SignInScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-t-deep t-bg-pattern px-4">
      <div className="t-card w-full max-w-sm p-8 text-center">
        <div className="mb-3 inline-block px-3 py-1 text-[10px] font-display uppercase tracking-[0.2em] text-t-accent border border-t-accent/40 rounded">
          Omega
        </div>
        <h1 className="mb-2 font-display text-2xl font-semibold text-t-bright">
          Not signed in
        </h1>
        <p className="mb-6 text-sm text-t-muted">
          Cloudflare Access protects this app. Reload to sign in with your
          @example.com Google account.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex w-full items-center justify-center gap-2 rounded border border-t-border bg-t-surface px-4 py-2 text-sm font-medium text-t-bright transition-colors hover:border-t-border-active hover:bg-t-hover"
        >
          Reload
        </button>
      </div>
    </main>
  )
}
