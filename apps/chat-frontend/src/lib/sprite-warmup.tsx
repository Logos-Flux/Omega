// Eager sprite provision on sign-in. After CF Access auth + Google connect
// have both passed, kicks off /api/session/start to provision the user's
// per-user sprite, then waits for the controller-side bootstrap to finish
// before declaring ready.
//
// Bootstrap takes ~3 min on a brand-new sprite (apt install of poppler/
// pandoc/weasyprint + npm globals + harness restart + healthz). That's far
// longer than Cloudflare's 100s edge timeout, so the initial POST fetch
// returns 524 well before the controller actually finishes. Rather than
// treating 524 as failure, we use it as a signal to switch into polling
// mode: GET /api/session/status every few seconds and watch for the row
// to appear with status='running' (autoProvisionAndBootstrap commits the
// row only after the full bootstrap succeeds, so a row visible via /status
// is a positive signal that the sprite is usable).
//
// Exposes the in-flight state so the chat surface can show a banner +
// disable the Agent toggle while provisioning. State machine:
//   idle          — provider mounted, request not yet fired
//   provisioning  — bootstrap in progress (visible "please wait" state)
//   ready         — sprite container row exists with status='running'
//   failed        — bootstrap returned a real error or polling timed out
//
// 409 from /start is also "in progress" (another tab/transport raced us);
// drops straight into polling.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type SpriteWarmupState =
  | { kind: 'idle' }
  | { kind: 'provisioning' }
  | { kind: 'ready' }
  | { kind: 'not_provisioned' }
  | { kind: 'sprite_missing' }
  | { kind: 'failed'; reason: string }

interface SpriteWarmupValue {
  state: SpriteWarmupState
  retry: () => void
}

const SpriteWarmupContext = createContext<SpriteWarmupValue | null>(null)

export function useSpriteWarmup(): SpriteWarmupValue {
  const ctx = useContext(SpriteWarmupContext)
  if (!ctx) throw new Error('useSpriteWarmup must be used inside <SpriteWarmupProvider>')
  return ctx
}

interface ProviderProps {
  /** True only after every upstream gate (auth, Google connect) has passed.
   *  We don't fire the warmup until then because /api/controller/api/session/*
   *  is gated by CF Access AND requires the user record. */
  enabled: boolean
  apiBase: string
  children: ReactNode
}

interface StatusResponse {
  container: { name: string; url: string | null; provider: string; lastSeenAt: string | null } | null
  status: 'running' | 'frozen' | 'gone'
}

const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000 // 5 min — covers worst-case first provision
const START_TIMEOUT_MS = 90_000 // CF cuts at ~100s; abort just before so we control the message

export function SpriteWarmupProvider({ enabled, apiBase, children }: ProviderProps) {
  const [state, setState] = useState<SpriteWarmupState>({ kind: 'idle' })
  // Per-tab dedupe: even if the parent re-renders, fire once per nonce.
  const fired = useRef(false)
  // Bumping this nonce re-runs the effect (manual retry path).
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!enabled) return
    if (fired.current && nonce === 0) return
    fired.current = true

    let cancelled = false
    const cancel = () => {
      cancelled = true
    }

    const startUrl = `${apiBase}/api/controller/api/session/start`
    const statusUrl = `${apiBase}/api/controller/api/session/status`

    const pollUntilReady = async (): Promise<void> => {
      const deadline = Date.now() + POLL_TIMEOUT_MS
      while (!cancelled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        if (cancelled) return
        try {
          const res = await fetch(statusUrl, { credentials: 'include' })
          if (!res.ok) {
            // /status itself failing isn't fatal during a long bootstrap —
            // CF / Caddy / controller restarts can blip. Keep polling.
            console.warn(`[sprite-warmup] /status ${res.status}, continuing poll`)
            continue
          }
          const data = (await res.json()) as StatusResponse
          if (data.container && data.status === 'running' && data.container.url) {
            if (!cancelled) setState({ kind: 'ready' })
            return
          }
        } catch (err) {
          console.warn(`[sprite-warmup] poll: ${(err as Error).message}; continuing`)
        }
      }
      if (!cancelled) {
        setState({
          kind: 'failed',
          reason: `bootstrap did not complete within ${POLL_TIMEOUT_MS / 1000}s`,
        })
      }
    }

    const fire = async (): Promise<void> => {
      setState({ kind: 'provisioning' })
      // Kick off /start; abort just before CF's 100s edge timeout so we get a
      // clean AbortError instead of a 524 HTML page. The controller keeps
      // running the bootstrap independently — our abort just lets us move
      // into polling mode early.
      const ctrl = new AbortController()
      const aborter = setTimeout(() => ctrl.abort(), START_TIMEOUT_MS)
      let res: Response | null = null
      try {
        res = await fetch(startUrl, {
          method: 'POST',
          credentials: 'include',
          signal: ctrl.signal,
        })
      } catch (err) {
        // AbortError or network drop. Either way the controller is still
        // working — fall through to polling.
        console.warn(`[sprite-warmup] /start aborted/blew up: ${(err as Error).message}`)
      } finally {
        clearTimeout(aborter)
      }

      if (cancelled) return

      if (res && res.ok) {
        // Existing-row fast path: bootstrap was already done before we even
        // asked. Skip polling.
        setState({ kind: 'ready' })
        return
      }
      if (res && res.status === 409) {
        // Concurrent provisioning. Whoever won is still bootstrapping; poll.
        await pollUntilReady()
        return
      }
      if (res && res.status === 503) {
        // Pre-provisioned-only mode: distinguish "never provisioned" from
        // "had a sprite but it's gone" so the banner can show the right
        // copy and we don't keep polling for a row that will never arrive.
        const body = await res.json().catch(() => null) as { error?: string } | null
        if (body?.error === 'not_provisioned') {
          if (!cancelled) setState({ kind: 'not_provisioned' })
          return
        }
        if (body?.error === 'sprite_missing') {
          if (!cancelled) setState({ kind: 'sprite_missing' })
          return
        }
        // Other 503 (golden missing, etc.) → generic failure.
        if (!cancelled) {
          setState({
            kind: 'failed',
            reason: `503 ${body?.error ?? res.statusText}`,
          })
        }
        return
      }
      if (res && res.status >= 400 && res.status !== 524) {
        // Real error from the controller (not a CF edge timeout). Surface it.
        const body = await res.text().catch(() => '')
        const reason = `${res.status} ${body.slice(0, 200) || res.statusText}`
        if (!cancelled) setState({ kind: 'failed', reason })
        return
      }
      // 524, abort, or no response → the controller is most likely still
      // running the bootstrap. Switch to polling.
      await pollUntilReady()
    }

    void fire()
    return cancel
  }, [enabled, nonce, apiBase])

  const retry = useCallback(() => {
    fired.current = false
    setNonce((n) => n + 1)
  }, [])

  const value = useMemo<SpriteWarmupValue>(() => ({ state, retry }), [state, retry])

  return <SpriteWarmupContext.Provider value={value}>{children}</SpriteWarmupContext.Provider>
}
