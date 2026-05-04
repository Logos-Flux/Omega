#!/bin/sh
set -eu

# bootstrap.ts shells out to `sprite` (sessions list/kill, exec, url update,
# and `sprite exec` from inside apply-golden) during fresh-sprite provision.
# The CLI does NOT read SPRITES_API_TOKEN from env per-invocation — it
# requires on-disk org binding written by `sprite auth setup`. Without this
# step every /api/session/start crashes mid-bootstrap with
#   Error: no organizations configured. Run 'sprite login' to authenticate
# the moment apply-golden tries its first `sprite exec`.
#
# The token format `org-slug/org-id/token-id/token-value` is the same value
# the SpritesProvider uses as a raw Bearer header for HTTP API calls, so one
# env var feeds both code paths.
#
# Only meaningful when this image (Dockerfile.sprites) is in use; the base
# Dockerfile in this directory targets the Docker provider and doesn't ship
# the sprite CLI.
if [ -n "${SPRITES_API_TOKEN:-}" ]; then
  sprite auth setup --token "$SPRITES_API_TOKEN" >/dev/null
else
  echo "[entrypoint] WARN: SPRITES_API_TOKEN not set — sprite CLI calls will fail" >&2
fi

exec "$@"
