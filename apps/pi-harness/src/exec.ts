import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceRoot } from './memory'

// Allowlist of binaries the model can invoke via the `exec` tool. Each entry
// is checked literally against the requested command — no shell, no PATH
// resolution beyond Bun.spawn's own. Adding a binary here is an explicit
// decision: it must be installed in the sprite and safe to expose.
export const EXEC_ALLOWLIST = new Set([
  'pdftotext',
  'pandoc',
  'gccli',
  'gdcli',
  'gmcli',
])

const TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 100_000 // 100 KB per stream

// Env var name prefixes that get forwarded to allowlisted binaries.
// Connectors (the gccli/gdcli/gmcli skills, future ones) need OAuth secrets in their env;
// everything else stays scrubbed so we don't leak ANTHROPIC_API_KEY etc.
// to subprocesses by accident.
const CONNECTOR_ENV_PREFIXES = ['GOOGLE_', 'STRIPE_']

function buildSubprocessEnv(): Record<string, string> {
  // /.sprite/bin is on PATH so connectors that use `#!/usr/bin/env node`
  // (gccli/gdcli/gmcli, anything else npm-installed) can find their
  // interpreter. The rest is the standard FHS path.
  const out: Record<string, string> = {
    PATH: '/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/home/sprite',
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue
    if (CONNECTOR_ENV_PREFIXES.some((p) => k.startsWith(p))) out[k] = v
  }
  return out
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
  durationMs: number
}

export async function runExec(
  command: string,
  args: string[],
  sessionId: string,
): Promise<ExecResult> {
  if (!EXEC_ALLOWLIST.has(command)) {
    throw new Error(`command not allowlisted: ${command}`)
  }
  if (!Array.isArray(args)) throw new Error('args must be an array')

  // Run inside the session's uploads dir so relative paths resolve to the
  // user's own files. Falls back to /workspace if no uploads exist yet.
  // Make sure the cwd exists. Sessions without prior uploads have no
  // /workspace/uploads/<sessionId>/ on disk yet — posix_spawn returns
  // ENOENT (misleadingly reporting the command path) if cwd is missing.
  const cwd = join(workspaceRoot(), 'uploads', sessionId)
  if (!existsSync(cwd)) await mkdir(cwd, { recursive: true })
  const start = Date.now()
  const env = buildSubprocessEnv()

  // Bun.spawn passes argv[0] straight to posix_spawn — no PATH lookup.
  // Resolve to an absolute path against the subprocess PATH so connectors
  // installed under /usr/local/bin (gccli/gdcli/gmcli, the gcal shim, etc.)
  // are reachable.
  const resolved = Bun.which(command, { PATH: env.PATH }) ?? command

  const proc = Bun.spawn([resolved, ...args], {
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
