FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# The Sprites CLI is only needed when COMPUTE_PROVIDER=sprites. The default
# DockerProvider talks to the Docker daemon socket directly. Operators
# wanting Sprites can extend this image:
#
#   FROM omega-controller:local
#   RUN apt-get update && apt-get install -y curl ca-certificates \
#       && curl -fsSL https://sprites.dev/install.sh \
#       | SPRITE_INSTALL_BIN_DIR=/usr/local/bin sh \
#       && sprite --version
#
# (or rebuild the controller image with this layer enabled).

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/migrations ./migrations

EXPOSE 3000

CMD ["bun", "run", "start"]
