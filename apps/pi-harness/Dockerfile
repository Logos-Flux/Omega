FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY . .
COPY skills /app/skills

# /workspace is the persistent mount the controller binds at runtime.
# When unset, the harness writes here so dev containers without an external
# volume still work end-to-end.
RUN mkdir -p /workspace

ENV WORKSPACE_ROOT=/workspace
ENV PORT=8080

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
