# Contributing to Omega

Apache-2.0 — by submitting a contribution you agree your work is licensed
under the same terms.

## Setup

```bash
git clone https://github.com/Logos-Flux/Omega.git
cd Omega
bun install                 # workspaces install all apps + packages/shell
```

The repo is a Bun workspace monorepo. Each app under `apps/` is independently
buildable; `packages/shell` is the shared shell + auth-stub package consumed by
`apps/chat-frontend`.

## Adding a compute provider

The `ComputeProvider` interface (`apps/controller/src/compute/types.ts`) has
four methods: `ensureContainer`, `freeze`, `destroy`, `status`. Implement them
in a new file under `apps/controller/src/compute/`, register the provider in
`compute/index.ts` behind a new `COMPUTE_PROVIDER` value, and add a section
to the README.

Tests for `DockerProvider` need a real Docker daemon — gate them behind a
`OMEGA_E2E=1` env so CI without Docker doesn't break.

## Code style

- TypeScript everywhere. No JS in source.
- Single quotes, two-space indent, no semicolons except where the parser needs them.
  (Match what's already in the file you're editing — most apps use semicolons.)
- Comment the *why*, not the *what*. Names should carry the "what."
- New routes go through whatever auth posture matches the rest of the file.
  Don't introduce new auth strategies without a discussion in an issue first.

## Sending a PR

- Open against `main`. Reference the issue you're fixing if there is one.
- Squash unless your commits tell a useful story.
- Run the relevant build (`bun run --cwd apps/<x> build` or `type-check`)
  before pushing.
- A new provider key, env var, or migration MUST be added to the relevant
  `.env.example` in the same PR.

## Reporting security issues

Please report vulnerabilities privately rather than opening a public issue.
See [SECURITY.md](./SECURITY.md) for the disclosure process and contact
address.
