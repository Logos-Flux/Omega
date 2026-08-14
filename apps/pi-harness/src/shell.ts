import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { workspaceRoot } from './memory'
import { buildSandboxEnv } from './exec'

// General-purpose shell access for the agent. Unlike `exec` (argv-only,
// allowlisted binaries), this runs an arbitrary command line through
// `bash -lc` in the sprite's persistent /workspace. The sprite container is
// the isolation boundary — ephemeral, per-user, JWT-gated — so arbitrary
// commands here are contained to that user's own sandbox.
//
// The env is scrubbed by buildSandboxEnv() (shared with exec): the harness's
// own secrets (ANTHROPIC_API_KEY, HARNESS_JWT_SECRET, RAG_SERVICE_TOKEN, …)
// are NOT passed to the child, so an `env` dump can't exfiltrate them into
// model-visible output. (Note: a child running as the same uid can still read
// /proc/<harness-pid>/environ — closing that needs a separate uid/namespace,
// tracked as follow-up hardening.)

const TIMEOUT_MS = 120_000 // 2 minutes for longer builds/installs
const MAX_OUTPUT_BYTES = 200_000 // 200 KB per stream

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
  durationMs: number
}

export async function runShell(command: string): Promise<ShellResult> {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('command must be a non-empty string')
  }

  // Persistent /workspace so clones, installs, and files survive across turns.
  const cwd = workspaceRoot()
  if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })

  const start = Date.now()
  const env = buildSandboxEnv()

  // -l: login shell so /etc/profile + PATH are set up; -c: run the command.
  const proc = Bun.spawn(['bash', '-lc', command], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })

  const timer = setTimeout(() => {
    proc.kill()
  }, TIMEOUT_MS)

  const [stdoutBuf, stderrBuf] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)

  const truncated = stdoutBuf.length > MAX_OUTPUT_BYTES || stderrBuf.length > MAX_OUTPUT_BYTES
  return {
    stdout: stdoutBuf.slice(0, MAX_OUTPUT_BYTES),
    stderr: stderrBuf.slice(0, MAX_OUTPUT_BYTES),
    exitCode: typeof exitCode === 'number' ? exitCode : -1,
    truncated,
    durationMs: Date.now() - start,
  }
}
