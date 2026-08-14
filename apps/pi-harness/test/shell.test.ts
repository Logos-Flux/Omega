/**
 * Tests for shell.ts — the general `bash -lc` shell tool.
 *
 * Run with: bun test apps/pi-harness/test/shell.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShell } from '../src/shell'

let dir: string
const OLD_WS = process.env.WORKSPACE_ROOT
const OLD_KEY = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'shell-test-')))
  process.env.WORKSPACE_ROOT = dir
})

afterEach(() => {
  if (OLD_WS === undefined) delete process.env.WORKSPACE_ROOT
  else process.env.WORKSPACE_ROOT = OLD_WS
  if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = OLD_KEY
  rmSync(dir, { recursive: true, force: true })
})

describe('runShell', () => {
  it('runs a command and captures stdout + exit code', async () => {
    const r = await runShell('echo hello')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
  })

  it('runs in the persistent /workspace cwd', async () => {
    const r = await runShell('pwd')
    expect(r.stdout.trim()).toBe(dir)
  })

  it('supports pipes and chaining', async () => {
    const r = await runShell('printf "a\\nb\\nc\\n" | wc -l')
    expect(r.stdout.trim()).toBe('3')
  })

  it('reports non-zero exit codes', async () => {
    const r = await runShell('exit 7')
    expect(r.exitCode).toBe(7)
  })

  it('does not leak harness secrets into the child env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak'
    const r = await runShell('echo "key=${ANTHROPIC_API_KEY:-absent}"')
    expect(r.stdout).toContain('key=absent')
  })

  it('rejects an empty command', async () => {
    await expect(runShell('   ')).rejects.toThrow()
  })
})
