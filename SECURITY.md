# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

<!-- Maintainers: confirm this address resolves to the right inbox before the
     first public disclosure cycle, and update if needed. -->

Email: **security@logosflux.io**

Include a clear description, steps to reproduce, the affected component(s)
(`chat-api`, `chat-frontend`, `controller`, `pi-harness`, `rag-api/api`,
`rag-api/ingest`, or `packages/shell`), and the commit SHA or release tag
you tested against. A working proof of concept is appreciated but not
required.

## Disclosure timeline

We aim for **90 days** from the date a report is acknowledged to a public
fix and advisory. We'll coordinate a release with you and credit you in the
[CHANGELOG](./CHANGELOG.md) unless you request otherwise. If a fix is
trivial we'll usually ship sooner; if a coordinated disclosure with
downstream users is needed we may request a short extension.

## Supported versions

Until v1.0.0 we support **only the latest tagged release** on `main`.
Older alphas/betas will not receive backported fixes.

## In scope

The OSS code in this repository, including:

- Authentication, authorisation, or session-handling bugs in the shipped
  middleware stubs (`apps/chat-api/src/middleware/session.ts`,
  `apps/controller/src/middleware/session.ts`).
- Sandbox-escape, container-breakout, or privilege-escalation issues in
  `pi-harness` or in the `controller`'s Docker / Sprites compute providers.
- Server-side request forgery, prompt-injection-driven exfiltration, or
  arbitrary file read/write affecting the host or other tenants.
- Secret leakage in logs, error messages, or response bodies.
- Denial-of-service issues that can be triggered with modest resources
  by an authenticated user.

## Out of scope

Omega ships with a documented "operator brings their own edge auth" model
(see [README → Auth](./README.md#auth-out-of-scope)). The following are
**not** in scope for this repo's security process:

- Misconfiguration of operator-deployed reverse proxies, oauth2-proxy,
  Caddy basic auth, Tailscale serve, Cloudflare Access, etc.
- Lack of built-in rate-limiting or WAF features — Omega expects the
  operator to add these at the edge.
- Issues that require root on the host, physical access, or a malicious
  Docker image already pushed by the operator.
- Vulnerabilities in third-party dependencies that don't affect Omega's
  shipped configuration; please report those upstream.
- Theoretical issues without a proof of concept against a recent build.

If you're not sure whether something is in scope, send the report anyway —
we'd rather triage and explain than miss a real issue.
