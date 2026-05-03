// Phase 0.B.5 — gccli/gdcli/gmcli boot shim.
//
// Pulls a fresh Google access token from the controller's
// /api/oauth/google/access-token endpoint and writes it to the
// `accounts.json` files that @mariozechner/gccli, gdcli, and gmcli read
// from `~/.gccli/`, `~/.gdcli/`, and `~/.gmcli/`. Each connector expects
// a JSON array of `{ email, oauth2: { clientId, clientSecret,
// refreshToken, accessToken? } }`.
//
// Architectural notes:
//
//   * The controller deliberately does NOT expose the user's
//     refresh_token over the wire (security). The connectors, OTOH,
//     only auto-refresh if their stored access_token expires — and the
//     google-auth-library happily uses a still-valid access_token
//     without ever touching the refresh_token. So we keep the cached
//     access_token fresh ourselves: mint at session start, then again
//     every 50 minutes (Google access tokens have a 1-hour TTL). The
//     `refreshToken` field is set to a placeholder string; if a call
//     ever does try to auto-refresh it'll fail at Google with a clear
//     error, which is louder than silently writing an invalid record.
//
//   * The harness today is a *single-user sprite* (one userId per
//     instance), so we cache by userId and only mint once per harness
//     boot — subsequent WS connects from the same user reuse the
//     cached token + the refresh-loop interval. If we ever go
//     multi-user-per-harness, this becomes a Map<userId, ...>.
//
//   * Email source: the controller's /access-token response returns
//     `{ access_token, expires_in, email? }`. We use the response's
//     `email` to key the accounts.json entry. If the controller omits
//     `email` (pathological state: user exists in pi.oauth_tokens but
//     not in chat.users), we mint+cache the access token but skip
//     writing accounts.json and log a clear warning.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 50 minutes — Google access tokens are 1h, so we refresh with 10min slack.
const REFRESH_INTERVAL_MS = 50 * 60 * 1000

// The connectors expect a non-empty refresh_token field. We never want
// google-auth-library to try refreshing — we manage that ourselves — so
// we use a sentinel string that fails loudly at Google if it's ever
// actually used.
const REFRESH_TOKEN_PLACEHOLDER = 'controller-managed-do-not-use'

// gccli/gdcli/gmcli all use the same accounts.json schema (per
// https://www.npmjs.com/package/@mariozechner/gccli source) — only
// the parent dir name differs.
const CONFIG_DIRS = ['.gccli', '.gdcli', '.gmcli'] as const

interface OAuth2Entry {
  clientId: string
  clientSecret: string
  refreshToken: string
  accessToken?: string
}

interface AccountEntry {
  email: string
  oauth2: OAuth2Entry
}

export interface MintedToken {
  access_token: string
  expires_in: number
  email?: string
}

export interface ShimConfig {
  controllerBaseUrl: string
  controllerServiceToken: string
  // OAuth client id/secret to record in accounts.json. The shim doesn't
  // *use* these (we never refresh client-side), but the connector
  // libraries instantiate an OAuth2Client with them, so they have to be
  // syntactically present. Empty strings are fine — google-auth-library
  // doesn't validate them until it tries to refresh.
  googleClientId: string
  googleClientSecret: string
}

export function readShimConfig(env: NodeJS.ProcessEnv = process.env): ShimConfig | null {
  const controllerBaseUrl = (env.CONTROLLER_BASE_URL ?? '').replace(/\/+$/, '')
  const controllerServiceToken = env.CONTROLLER_SERVICE_TOKEN ?? ''
  if (!controllerBaseUrl || !controllerServiceToken) return null
  return {
    controllerBaseUrl,
    controllerServiceToken,
    googleClientId: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
  }
}

/**
 * Call the controller's mint endpoint. Throws on non-2xx; returns the
 * `{ access_token, expires_in }` payload otherwise.
 *
 * Exported for testing.
 */
export async function mintGoogleToken(
  args: { userId: string; controllerBaseUrl: string; controllerServiceToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MintedToken> {
  const res = await fetchImpl(
    `${args.controllerBaseUrl}/api/oauth/google/access-token`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.controllerServiceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ userId: args.userId }),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`controller mint ${res.status}: ${body || '<empty>'}`)
  }
  const body = (await res.json().catch(() => null)) as
    | { access_token?: unknown; expires_in?: unknown; email?: unknown }
    | null
  if (
    !body ||
    typeof body.access_token !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    throw new Error('controller mint response missing access_token/expires_in')
  }
  const out: MintedToken = {
    access_token: body.access_token,
    expires_in: body.expires_in,
  }
  if (typeof body.email === 'string' && body.email.length > 0) {
    out.email = body.email
  }
  return out
}

/**
 * Read an existing accounts.json (or return []). Tolerant of a missing
 * file or malformed contents — a corrupt file gets overwritten on the
 * next write, which is the correct outcome for a controller-managed
 * config.
 */
async function readAccounts(path: string): Promise<AccountEntry[]> {
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as AccountEntry[]
    return []
  } catch {
    return []
  }
}

/**
 * Merge-write the given account entry into a single accounts.json. If
 * an entry with the same email already exists, it's replaced in place
 * (preserves array order); otherwise the new entry is appended.
 *
 * Exported for testing.
 */
export async function writeAccountsJson(
  path: string,
  entry: AccountEntry,
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const existing = await readAccounts(path)
  const idx = existing.findIndex((a) => a.email === entry.email)
  if (idx >= 0) {
    existing[idx] = entry
  } else {
    existing.push(entry)
  }
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
}

/**
 * Write the same account entry into all three connector config dirs
 * (`~/.gccli/`, `~/.gdcli/`, `~/.gmcli/`). Single-call wrapper.
 *
 * `home` defaults to `os.homedir()`; tests pass a tmp path.
 */
export async function writeGccliAccounts(
  args: {
    email: string
    accessToken: string
    googleClientId: string
    googleClientSecret: string
  },
  home: string = homedir(),
): Promise<void> {
  const entry: AccountEntry = {
    email: args.email,
    oauth2: {
      clientId: args.googleClientId,
      clientSecret: args.googleClientSecret,
      refreshToken: REFRESH_TOKEN_PLACEHOLDER,
      accessToken: args.accessToken,
    },
  }
  for (const dir of CONFIG_DIRS) {
    await writeAccountsJson(join(home, dir, 'accounts.json'), entry)
  }
}

interface ShimState {
  userId: string
  timer: ReturnType<typeof setInterval>
}

let active: ShimState | null = null

/**
 * Mint once + start the refresh loop. Idempotent on the same userId
 * (returns the in-flight state without re-minting). If called with a
 * different userId, the previous loop is cancelled.
 *
 * Errors are logged and swallowed — a transient controller blip should
 * never crash the harness boot. The next refresh tick will retry.
 */
export async function startGccliShim(args: {
  userId: string
  config: ShimConfig
  home?: string
  fetchImpl?: typeof fetch
  intervalMs?: number
  onError?: (err: unknown, phase: 'mint' | 'write') => void
}): Promise<void> {
  if (active && active.userId === args.userId) return
  if (active) {
    clearInterval(active.timer)
    active = null
  }

  const home = args.home ?? homedir()
  const fetchImpl = args.fetchImpl ?? fetch
  const interval = args.intervalMs ?? REFRESH_INTERVAL_MS
  const onError =
    args.onError ??
    ((err, phase) => {
      console.error(`[gccli-shim] ${phase} failed:`, (err as Error).message ?? err)
    })

  const refresh = async (): Promise<void> => {
    let token: MintedToken
    try {
      token = await mintGoogleToken(
        {
          userId: args.userId,
          controllerBaseUrl: args.config.controllerBaseUrl,
          controllerServiceToken: args.config.controllerServiceToken,
        },
        fetchImpl,
      )
    } catch (err) {
      onError(err, 'mint')
      return
    }
    if (!token.email) {
      // Token minted, but the controller didn't return an email for
      // this user (pathological: user has oauth tokens but no
      // chat.users row). Log once at warn and bail — the next tick
      // will re-warn, which is desired (operators see the issue).
      console.warn(
        '[gccli-shim] controller returned no email for user — ' +
          'minted access token but skipping ~/.gccli/accounts.json write. ' +
          'Likely cause: user row missing in chat.users.',
      )
      return
    }
    try {
      await writeGccliAccounts(
        {
          email: token.email,
          accessToken: token.access_token,
          googleClientId: args.config.googleClientId,
          googleClientSecret: args.config.googleClientSecret,
        },
        home,
      )
    } catch (err) {
      onError(err, 'write')
    }
  }

  await refresh()
  const timer = setInterval(() => {
    void refresh()
  }, interval)
  // Don't keep the event loop alive for this interval — the WS server
  // is the actual "I want to be running" signal.
  if (typeof timer.unref === 'function') timer.unref()

  active = { userId: args.userId, timer }
}

/**
 * Cancel the refresh loop. Test-only convenience; production never
 * needs this because the harness process exits on shutdown anyway.
 */
export function stopGccliShim(): void {
  if (active) {
    clearInterval(active.timer)
    active = null
  }
}
