FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

# CLI toolchain for the `shell` tool + the skills that shell out via `exec`.
# bash ships in the base image. poppler-utils provides pdftotext (pdf-extract)
# and pdftoppm (the ocr skill's scanned-PDF bridge); tesseract-ocr backs the
# ocr skill. On the Sprites path these come from the golden apt manifest; the
# Docker path (this image: local compose, Helsinki, Legion) installs them here
# so the same skills work. Deliberately slim otherwise — no language runtimes
# unless a skill needs one.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates jq \
    poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

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
