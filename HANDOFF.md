# Handoff — 2026-08-13

## Current state
Dependency-update session. All eight open Dependabot PRs were resolved: #32 (actions/checkout 7), #33 (ai-sdk group → ai v7), #34 (typescript 7.0.2), #37 (googleapis 174.0.1), #39 (hono group), #40 (react group), #41 (assistant-ui 0.15.13), #42 (lucide-react 1.31.0) merged; #36/#38 closed as superseded. Two follow-on fixes landed directly on main: the AI SDK v7 migration (`allowSystemInMessages: true` in pi-harness engine, bridge-package bumps + `useMessage` → `useAuiState` in chat-frontend), and a CI fix (`tsc -b --noEmit`) that closed a blind spot where chat-frontend's solution-style tsconfig made typecheck a no-op. Main is green: full typecheck, 304 tests, chat-frontend production build all pass.

## Next steps
1. Deploy when convenient — the merged dependency updates and migration fixes are not live until the Fly apps (52launch-chat-api, 52launch-controller, …) are redeployed. No deploy was run this session.
2. Smoke-test source citations in chat-frontend after deploy: `SourcePart` was migrated to the 0.15 `useAuiState` API and now skips document-type sources (no URL). Perplexity/Gemini citation chips should render as before.
3. Optional: chat-frontend build warns about >500 kB chunks; code-splitting is untouched debt.

## Decisions made this session
- `.github/dependabot.yml` switched `package-ecosystem: npm` → `bun`: Dependabot now regenerates `bun.lock` in its PRs, which is why the npm-era PRs all failed CI at `bun install --frozen-lockfile`.
- Kept system messages inside `messages` (via `allowSystemInMessages: true`) rather than the v7 `system`/`instructions` options — the engine deliberately sends multiple system blocks so each keeps its own Anthropic `cache_control` marker.
- Bumped `@assistant-ui/react-ai-sdk` to 1.4.x: the 1.3.x line pins ai@6/core@0.1 and had two copies of each package coexisting in node_modules, which was the true source of the App.tsx type clashes.

## Known debt / open questions
- >500 kB chunk warning in chat-frontend build (pre-existing).
- `apps/chat-frontend/Caddyfile.52launch` is untracked at the repo root of chat-frontend — Chris's launch-day Caddy variant (CF Pages `/chat/` prefix routing). Left untouched; decide whether to commit or gitignore.

## In-flight remote state
- No open PRs, no unmerged branches (feat/session-start-409-retry deleted — its patch merged long ago as PR #18).
- CI on main: green as of 3d77d9c.
- `gh` on this machine has two accounts: **CyberBrown is pull-only on Logos-Flux/Omega; merge/push requires `gh auth switch -u Logos-Flux`** (switched back to CyberBrown at session end).
