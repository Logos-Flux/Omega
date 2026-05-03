FROM oven/bun:1 AS builder
WORKDIR /omega

# Bring in workspace plumbing so the workspace dep `@omega-inc/app-shell`
# resolves at install time. We copy only what's needed for install.
COPY package.json bun.lock ./
COPY apps/chat-frontend/package.json apps/chat-frontend/
COPY packages/shell/package.json packages/shell/
RUN bun install

# Now bring in the rest and build.
COPY apps/chat-frontend apps/chat-frontend
COPY packages/shell packages/shell
RUN bun run --cwd apps/chat-frontend build

FROM caddy:2-alpine AS runner
COPY --from=builder /omega/apps/chat-frontend/dist /srv
COPY apps/chat-frontend/Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
