# Operator scripts

Two standalone scripts for managing per-user pi-harness sandboxes against the
[Sprites](https://sprites.dev) compute provider. Both are operator workflows
(run them yourself; not invoked by the controller process):

- `provision-user.ts <email>` — first-time provision: creates the sprite,
  applies the latest golden manifest for the user's release channel, boots
  the harness, flips URL auth to `public`. Idempotent.
- `update-user.ts <email>` — drift-fixer: re-applies the latest golden if
  the user's `pi.containers.base_image_version` is behind, restarts the
  harness with the new bundle, writes an audit row.

## Required env

Both scripts read secrets via [pass-cli](https://github.com/erichbaek/pass-cli)
by default, but every value also has an env-var override that wins. Pick one
or both — typically you set `PASS_VAULT_NAME` and let the rest fall back to
the defaults that match Proton Pass entry titles.

| Var | Default | Purpose |
|---|---|---|
| `PASS_VAULT_NAME` | *(required)* | Which Proton Pass vault to read from. No default; the scripts `die` if unset. |
| `PASS_ITEM_SPRITES_TOKEN` | `Sprites — API token` | Pass entry holding the Sprites API token (`password` field). |
| `PASS_ITEM_HARNESS_JWT_SECRET` | `HARNESS_JWT_SECRET` | Pass entry holding the controller↔harness JWT secret. |
| `PASS_ITEM_CONTROLLER_SVC_TOKEN` | `Controller — service token` | Pass entry holding the controller service token used by the gccli boot shim. |
| `PASS_ITEM_GOOGLE_OAUTH_CONNECTORS` | `Google OAuth — connectors` | Pass entry with `client_id` + `client_secret` fields for the harness Google connectors. |
| `PASS_ITEM_ANTHROPIC` | `Claude API` | Pass entry with the `API Key` field. |
| `PASS_ITEM_GOOGLE_AI` | `Gemini API` | Pass entry with the `API Key` field. |
| `PASS_ITEM_PERPLEXITY` | `Perplexity API` | Pass entry with the `API Key` field. |

Direct env-var overrides — set any of these and pass-cli is skipped for that
secret:

| Env var | Replaces |
|---|---|
| `SPRITES_API_TOKEN` | `PASS_ITEM_SPRITES_TOKEN` lookup |
| `HARNESS_JWT_SECRET` | `PASS_ITEM_HARNESS_JWT_SECRET` lookup |
| `CONTROLLER_SERVICE_TOKEN` | `PASS_ITEM_CONTROLLER_SVC_TOKEN` lookup |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | `PASS_ITEM_GOOGLE_OAUTH_CONNECTORS` lookups |
| `ANTHROPIC_API_KEY` | `PASS_ITEM_ANTHROPIC` lookup |
| `GOOGLE_API_KEY` | `PASS_ITEM_GOOGLE_AI` lookup |
| `PERPLEXITY_API_KEY` | `PASS_ITEM_PERPLEXITY` lookup |

## Usage

```bash
# pass-cli path — only PASS_VAULT_NAME is required
PASS_VAULT_NAME=my-vault bun apps/controller/scripts/provision-user.ts user@example.com

# fully env-driven, no pass-cli involvement
PASS_VAULT_NAME=unused \
SPRITES_API_TOKEN=... \
HARNESS_JWT_SECRET=... \
CONTROLLER_SERVICE_TOKEN=... \
GOOGLE_OAUTH_CLIENT_ID=... \
GOOGLE_OAUTH_CLIENT_SECRET=... \
ANTHROPIC_API_KEY=... \
GOOGLE_API_KEY=... \
PERPLEXITY_API_KEY=... \
bun apps/controller/scripts/update-user.ts user@example.com
```

Both scripts also need `controllerUrl()` to point at your running controller
admin endpoint — see `scripts/lib.ts` for that resolution.
