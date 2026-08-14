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
  // OCR: tesseract reads an image and prints recognised text to stdout.
  // pdftoppm (poppler-utils, already installed for pdftotext) rasterises a
  // scanned PDF to PNG so it can be fed to tesseract — closing the
  // "scanned PDF / no OCR" gap pdf-extract punts on. The `ocr` skill
  // (apps/pi-harness/skills/ocr) drives both. tesseract needs the
  // `tesseract-ocr` apt package in the sprite golden manifest.
  'tesseract',
  'pdftoppm',
  'pandoc',
  'gccli',
  'gdcli',
  'gmcli',
])

const TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 100_000 // 100 KB per stream

// BUG-01 — explicit per-variable allowlist of env forwarded to `exec`/`shell`
// children (both go through buildSandboxEnv). The previous `GOOGLE_`/`STRIPE_`
// PREFIX forwarding leaked secrets: the controller injects GOOGLE_API_KEY (the
// shared Gemini billing key) and GOOGLE_OAUTH_CLIENT_SECRET into the harness
// env, and `exec env` / `shell env` printed them into model-visible output that
// then persists into conversation.jsonl. The connectors (gccli/gdcli/gmcli)
// read their OAuth credentials from ~/.gccli/accounts.json (written by the boot
// shim), NOT from env, so nothing secret needs to cross into a child.
//
// Forward ONLY these explicitly-named, non-secret vars. Anything whose name
// looks like a credential is refused even if added here by mistake.
const EXEC_ENV_ALLOWLIST = new Set<string>([
  // OAuth client id is not a secret; some connector code paths read it to
  // instantiate an OAuth2Client. The matching *_CLIENT_SECRET is deliberately
  // NOT forwarded — accounts.json carries it for the connectors that need it.
  'GOOGLE_OAUTH_CLIENT_ID',
])

const SECRET_NAME_RE = /(_KEY|_SECRET|_TOKEN|PASSWORD)$/i

export function buildSandboxEnv(): Record<string, string> {
  // /.sprite/bin is on PATH so connectors that use `#!/usr/bin/env node`
  // (gccli/gdcli/gmcli, anything else npm-installed) can find their
  // interpreter. The rest is the standard FHS path.
  const out: Record<string, string> = {
    PATH: '/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/home/sprite',
  }
  for (const k of EXEC_ENV_ALLOWLIST) {
    const v = process.env[k]
    if (typeof v === 'string' && v.length > 0 && !SECRET_NAME_RE.test(k)) out[k] = v
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
  const env = buildSandboxEnv()

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
