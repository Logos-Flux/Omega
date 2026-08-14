// Memory HTTP routes (#5) — GET/PUT/DELETE of /workspace/memory/_global.md.
// Isolated temp WORKSPACE_ROOT set before importing the module.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK_ROOT = mkdtempSync(join(tmpdir(), 'pi-harness-memory-routes-'))
process.env.WORKSPACE_ROOT = WORK_ROOT

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'

const { handleMemoryRoute } = await import('../src/memory-routes')

function makeRequest(method: string, path: string, body?: unknown): Request {
  const url = `http://harness.local${path}`
  if (body === undefined) return new Request(url, { method })
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  await rm(join(WORK_ROOT, 'memory'), { recursive: true, force: true })
  // writeSystemMemory writes into memory/ — ensureWorkspace makes this dir
  // at boot; the route tests create it directly.
  await mkdir(join(WORK_ROOT, 'memory'), { recursive: true })
})

afterAll(async () => {
  if (existsSync(WORK_ROOT)) await rm(WORK_ROOT, { recursive: true, force: true })
})

describe('GET /memory', () => {
  test('returns an empty string when nothing is stored', async () => {
    const r = await handleMemoryRoute(makeRequest('GET', '/memory'))
    expect(r?.status).toBe(200)
    expect(r?.body).toEqual({ memory: '' })
  })
})

describe('PUT /memory', () => {
  test('stores and reads back the content', async () => {
    const put = await handleMemoryRoute(makeRequest('PUT', '/memory', { memory: '## 2026-06-08\nLikes tea.' }))
    expect(put?.status).toBe(200)
    const get = await handleMemoryRoute(makeRequest('GET', '/memory'))
    expect((get?.body as { memory: string }).memory).toBe('## 2026-06-08\nLikes tea.')
  })

  test('400 when memory is not a string', async () => {
    const r = await handleMemoryRoute(makeRequest('PUT', '/memory', { memory: 42 }))
    expect(r?.status).toBe(400)
  })

  test('400 on invalid json', async () => {
    const r = await handleMemoryRoute(
      new Request('http://harness.local/memory', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
    )
    expect(r?.status).toBe(400)
  })
})

describe('DELETE /memory', () => {
  test('clears the store', async () => {
    await handleMemoryRoute(makeRequest('PUT', '/memory', { memory: 'something' }))
    const del = await handleMemoryRoute(makeRequest('DELETE', '/memory'))
    expect(del?.status).toBe(200)
    const get = await handleMemoryRoute(makeRequest('GET', '/memory'))
    expect((get?.body as { memory: string }).memory).toBe('')
  })
})

describe('non-memory routes', () => {
  test('returns null so the caller falls through', async () => {
    expect(await handleMemoryRoute(makeRequest('GET', '/profile'))).toBeNull()
  })
})
