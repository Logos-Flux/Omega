# WP-894 — Agent Mode minted a new sessionId on every WS reconnect

**Reported:** customer report, 2026-07-15; plausibly also behind
kclapp@ and part of kl@.

**User symptom:** uploaded context files are only seen on the first prompt;
follow-up questions in the same chat "lose" the uploads and prior history, as
if each prompt is a separate chat. The assistant even told the user *"each
chat turn starts fresh for me unless something was saved to memory"* — that
string is **not** in the harness prompt; the model confabulated an explanation
for a genuinely-empty transcript, which actively taught a false mental model.

## Root cause (confirmed from code)

Agent Mode keys **both** conversation history
(`/workspace/conversations/<sessionId>.jsonl`, `pi-harness/src/engine.ts`) and
uploads (`listUploads(sessionId)`, `pi-harness/src/assembler.ts` slot 13) by
the harness sessionId. So a *new* sessionId on reconnect ⇒ new empty jsonl +
new empty uploads dir ⇒ "this is a new chat, re-upload everything."

The churn: `HarnessTransport` held the resume target (`resumeSessionId`) only
from the **constructor** — the thread-switcher "resume a past session" case.
In a brand-new agent chat nothing ever updated it to the sessionId the
controller had just minted. The failure sequence on any WS drop (sprite
idle-checkpoint, network blip, laptop sleep, backgrounded tab):

1. `onWsClose` → `this.session = null` (`harness-transport.ts`).
2. Next `ensureSession()` → `openSession()` → `startSessionWithRetry()`.
3. POST `/api/session/start` with **no body** (resumeSessionId still unset) →
   controller's `recordSessionStart` mints a **fresh** sessionId
   (`controller/src/routes/session.ts:417-419`).
4. New session ⇒ empty history + empty uploads.

There was also **no WebSocket keepalive**, so a half-dead socket (laptop sleep,
Wi-Fi handoff) could sit unreported by the browser — the next message then
stalled on "Thinking…" against a socket `readyState` still `OPEN`.

> Note on the controller `/heartbeat` endpoint: it only bumps
> `pi.containers.last_seen_at` (admin ordering + provisioning-row cleanup).
> Sprites auto-checkpoint on idle **internally** (`compute/sprites.ts:42`) —
> `last_seen_at` does **not** gate that. So an HTTP heartbeat poll would have
> been cosmetic (and would have re-introduced the periodic poller WP-896 just
> removed). The real keepalive is application-level WS ping/pong.

## Fix

Two changes, on branch `fix/wp894-agent-mode-session-churn`.

### 1. Adopt the minted sessionId so reconnect resumes it (the actual bug)

`chat-frontend/src/lib/harness-transport.ts` — after `openSession()` resolves,
set `this.resumeSessionId = s.sessionId`. The next reconnect now POSTs
`{resumeSessionId}`; the controller's `resumeSessionIfOwned` validates
ownership and returns the same id, so the harness loads the existing jsonl
history and the same uploads dir. Works for every drop cause (the sprite's
workspace persists across its cold/warm checkpoint). Always adopts whatever
the controller returned, so it self-corrects if ownership ever fails and the
controller falls back to a fresh id.

### 2. Application-level WS keepalive (detect half-dead sockets)

Browsers can't emit WS protocol pings from JS, and the harness rejected
unknown frame types, so:

- `pi-harness/src/index.ts` — handle `{type:'ping'}` → reply `{type:'pong'}`.
- `chat-frontend` — a watchdog (`startKeepalive`/`keepaliveTick`) sends a
  ping only when the connection has been genuinely idle (active turns keep
  resetting the idle timer, so streaming never generates ping noise). If a
  ping goes unanswered past `WS_KEEPALIVE_TIMEOUT_MS` (15s — a live sprite
  answers in milliseconds), the socket is half-dead: force-close it so the
  existing `onWsClose → reconnect → resume` path fires, instead of stranding
  the user's next message.

Tunables `WS_KEEPALIVE_INTERVAL_MS` / `WS_KEEPALIVE_TIMEOUT_MS` live in
`harness-utils.ts` next to `WS_RETRY_DELAYS_MS`.

## Tests

`chat-frontend/src/lib/harness-transport.test.ts` gains four regressions (all
green; the existing two still pass):

- **reconnect resumes the same session** — after a simulated WS drop the
  second `/api/session/start` POSTs exactly `{resumeSessionId:'sess-1'}` and
  the active session is unchanged (pre-fix this posted `''`).
- **idle socket is pinged; pong clears the probe** (no spurious close).
- **active traffic suppresses the ping**.
- **unanswered ping force-closes the half-dead socket**.

The harness-side `ping→pong` dispatch is a straight-through handler; per the
repo's stated convention (`test/rewind.test.ts`) straight-through WS dispatch
in `index.ts` is not unit-tested in isolation — the client-side tests pin the
contract (send ping, accept pong, force-close on no-pong).

## Out of scope / follow-ups

- **Cross-reload** resume is already handled by the thread-switcher's
  `resumeSessionId` flow and was not the reported symptom ("within the same
  chat").
- If the team later wants sub-15s detection of mid-turn deaths, lower
  `WS_KEEPALIVE_INTERVAL_MS`; the watchdog only pings during genuine idle, so
  a shorter interval costs almost nothing on an active connection.
