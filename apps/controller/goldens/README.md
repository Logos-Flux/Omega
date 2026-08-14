# Goldens

A **golden** is a versioned recipe for the contents of a per-user `sprite`
environment: which apt packages, which globally-installed npm connectors,
the pi-harness bundle, fs permissions, and the read-only baked skills
tree. The recipe lives in a JSON manifest; the controller stamps the
manifest version onto `/etc/52l/version.json` inside the sprite once
every step lands successfully.

This directory holds **operator-published** goldens. The OSS source tree
ships only the [`example/`](./example) subdirectory; everything else in
this folder is gitignored and intended to be populated by the operator
running the controller.

## When to publish a new golden

- Bumping a baked dependency (gccli, gdcli, gmcli, apt packages).
- Rolling the pi-harness JS bundle.
- Changing the default skills set shipped to every sprite.
- Changing fs permissions / ownership of a tracked path on the sprite.

If none of those apply, a `golden_images` row update is overkill — the
running fleet is fine. New users get the latest non-retired golden in
their channel at first provision (`apps/controller/src/routes/session.ts:
autoProvisionAndBootstrap`).

## Layout convention

```
apps/controller/goldens/
  README.md              ← this file
  example/               ← shipped in OSS, illustrative only
    manifest.json
  1.0.0/                 ← operator-published, gitignored
    manifest.json
    pi-harness.js
  1.0.1/
    ...
```

The example directory and a top-level `.gitignore` rule (`/apps/controller/
goldens/*/` excluding `example/`) keep operator artifacts from
accidentally landing in upstream commits.

## Manifest shape

The schema is enforced by `apps/controller/scripts/apply-golden.ts`:

```jsonc
{
  "version": "1.0.0",                // matches the directory name and the pi.golden_images row
  "notes": "Free-form release notes",
  "os": "ubuntu-25.10",              // informational; sprites inherit the image OS

  "apt_packages": [
    { "name": "poppler-utils", "min_version": "25.03.0" }
  ],

  "npm_globals": [
    { "name": "@mariozechner/gccli", "version": "0.1.2", "binary": "gccli" }
  ],

  "harness_bundle": {
    "path": "pi-harness.js",         // local file in the manifest's directory
    "remote_path": "/home/sprite/pi-harness.js",
    "sha256": "<hex sha256 of path>"
  },

  "fs_setup": [
    { "path": "/home/sprite", "mode": "755", "owner": "ubuntu:ubuntu" }
  ],

  "default_skills": {                // optional — only set when shipping skills
    "local_path": "../../../pi-harness/skills",  // relative to manifest dir
    "remote_path": "/home/sprite/skills"
  }
}
```

### `default_skills` and the canonical tree

The repo ships its canonical skills tree at `apps/pi-harness/skills/`.
Point `default_skills.local_path` at that tree (relative to the manifest
file) so there's one source of truth: edits land in
`apps/pi-harness/skills/` and the next published golden picks them up
without a copy step.

`apply-golden.ts` tars the tree, uploads it to the sprite, and replaces
`default_skills.remote_path` wholesale — removed skills actually
disappear from running sprites. User-authored skills under
`/workspace/skills/` are untouched.

## Operator workflow

1. **Build the harness bundle.**

   ```bash
   cd apps/pi-harness
   bun build src/index.ts --outdir ../controller/goldens/<version>/ \
     --target bun --minify
   # rename to pi-harness.js to match the manifest convention
   ```

2. **Compute the sha and stamp the manifest.**

   ```bash
   sha256sum apps/controller/goldens/<version>/pi-harness.js | awk '{print $1}'
   # paste into manifest.harness_bundle.sha256
   ```

3. **Register in `pi.golden_images`.** The controller looks this row up
   at provision time; without it the new version is invisible to the
   provisioner.

   ```sql
   INSERT INTO pi.golden_images (version, manifest_uri, manifest_sha, notes, released_to)
   VALUES (
     '1.0.1',
     'file://goldens/1.0.1/manifest.json',  -- MUST be file:// (see below)
     '<sha256 of the manifest.json file itself>',
     'Bump gccli to 0.1.3, add note-taking-v2 skill.',
     ARRAY['alpha']                       -- start in alpha; promote later
   );
   ```

   ⚠️ **`manifest_uri` MUST use the `file://` scheme**, relative to the
   controller's runtime cwd (`process.cwd()` = `/app` in the deployed image).
   `bootstrap.ts::resolveManifestPath` ONLY accepts `file://` (or an absolute
   path after it) and THROWS `unsupported manifest_uri scheme` on anything else
   — which 500s every `/api/session/start` for users on that channel until the
   row is fixed. The controller build bakes `fly/goldens/<v>/` into
   `/app/goldens/<v>/`, so the correct value is **`file://goldens/<v>/manifest.json`**
   (NOT `apps/controller/goldens/...` — that bare path was the format that broke
   golden 1.0.8 on 2026-06-11). Operators using object storage may instead put an
   `https://` URL here only if resolveManifestPath is extended to accept it.

   After registering a golden, ALWAYS verify a real `/api/session/start`
   re-bootstrap succeeds (not just that the row + bundle exist) — a bad
   manifest_uri only surfaces at bootstrap time.

4. **Apply to a test sprite.**

   ```bash
   cd apps/controller
   bun scripts/apply-golden.ts harness-<id> 1.0.1
   # Or, when the version label differs from the directory:
   bun scripts/apply-golden.ts harness-<id> 1.0.1-rc1 goldens/1.0.1/manifest.json
   ```

   Confirm the sidebar shows the expected skills (`sprite exec -s
   harness-<id> -- ls /home/sprite/skills/`) and `/etc/52l/version.json`
   stamps the new version.

5. **Promote channels.**

   ```sql
   UPDATE pi.golden_images
   SET released_to = array_append(released_to, 'beta'),
       promoted_at = promoted_at || jsonb_build_object('beta', NOW())
   WHERE version = '1.0.1' AND NOT 'beta' = ANY(released_to);
   ```

   New `chat.users` rows inherit their release channel via
   `migrations/0002_versioning.sql`; users get the latest non-retired
   golden in their channel on next provision.

6. **Retire a known-bad version.**

   ```sql
   UPDATE pi.golden_images SET retired_at = NOW() WHERE version = '1.0.1';
   ```

   Retiring blocks fresh provisions but doesn't touch already-bootstrapped
   sprites. Use `apply-golden.ts <sprite> <good-version>` to roll those
   forward.

## Gotchas

- **The version label is what gets stamped**, not `manifest.version`.
  Passing `1.0.1-rc1` on the CLI while reusing `goldens/1.0.0/manifest.
  json` stamps `1.0.1-rc1` — handy for re-labels without a content
  change.
- **`apply-golden.ts` is idempotent.** Every step is checked-then-
  installed, so re-running on a fully-current sprite is a no-op. Use
  this for in-place updates as well as fresh provisions.
- **Skills upload replaces the whole tree.** A skill removed upstream
  disappears from sprites on next apply. If you want to keep a deprecated
  skill around indefinitely, fork the tree into the goldens directory
  and point `default_skills.local_path` at the fork.
- **`/etc/52l/version.json` is stamped last.** If any earlier step fails,
  the stamp doesn't move — `version.json` only ever advances when the
  full apply succeeds, which means it's safe to use as the "what's on
  this sprite right now" check from the chat UI.
