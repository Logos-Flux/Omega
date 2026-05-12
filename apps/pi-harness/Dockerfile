FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .

# Bake skills/personas/soul under /home/sprite/ — that's the read-only
# "golden" tree that skills.ts, personas.ts, souls.ts, and quick_actions.ts
# scan at runtime (alongside the per-user mutable copies under /workspace/).
# Without this the harness boots with `loaded 0 skill(s)` and no default
# persona/soul, even though the source tree ships them.
RUN mkdir -p /home/sprite
COPY skills /home/sprite/skills
COPY personas /home/sprite/personas
COPY soul.md /home/sprite/soul.md

# /workspace is the persistent mount the controller binds at runtime.
# When unset, the harness writes here so dev containers without an external
# volume still work end-to-end.
RUN mkdir -p /workspace

ENV WORKSPACE_ROOT=/workspace
ENV PORT=8080

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
