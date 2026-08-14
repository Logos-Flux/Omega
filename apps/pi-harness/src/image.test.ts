import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isImageGenEnabled, generateImage } from './image'

// generate_image runs IN the harness process (the exec sandbox can't reach the
// API or hold the key) and must save each PNG into the session uploads dir via
// uploadPath — the same path the /files download endpoint serves. These tests
// mock fetch so no real Ideogram call is made.

const realFetch = globalThis.fetch
let workdir = ''

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'imgtest-'))
  process.env.WORKSPACE_ROOT = workdir
})

afterEach(async () => {
  globalThis.fetch = realFetch
  delete process.env.IDEOGRAM_API_KEY
  delete process.env.WORKSPACE_ROOT
  if (workdir) await rm(workdir, { recursive: true, force: true })
})

describe('isImageGenEnabled', () => {
  test('gates on IDEOGRAM_API_KEY presence', () => {
    delete process.env.IDEOGRAM_API_KEY
    expect(isImageGenEnabled()).toBe(false)
    process.env.IDEOGRAM_API_KEY = 'k'
    expect(isImageGenEnabled()).toBe(true)
  })
})

describe('generateImage', () => {
  test('posts multipart with Api-Key, downloads + saves the PNG to uploads', async () => {
    process.env.IDEOGRAM_API_KEY = 'test-key'
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const calls: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString()
      calls.push({ url: u, init })
      if (u.includes('ideogram-v3/generate')) {
        return new Response(
          JSON.stringify({
            created: '2026-06-24T00:00:00Z',
            data: [{ url: 'https://img.ideogram.ai/abc.png', prompt: 'enhanced apple', resolution: '1024x1024', seed: 42, is_image_safe: true }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as typeof fetch

    const result = await generateImage(
      { prompt: 'an apple', aspect_ratio: '1x1', rendering_speed: 'FLASH' },
      'sess-1',
    )

    // generate call carried the auth header + multipart body
    const gen = calls.find((c) => c.url.includes('generate'))!
    expect((gen.init?.headers as Record<string, string>)['Api-Key']).toBe('test-key')
    expect(gen.init?.body).toBeInstanceOf(FormData)
    expect((gen.init?.body as FormData).get('prompt')).toBe('an apple')
    expect((gen.init?.body as FormData).get('rendering_speed')).toBe('FLASH')

    // one image saved, bytes intact, name surfaced
    expect(result.images).toHaveLength(1)
    expect(result.rendered_prompt).toBe('enhanced apple')
    const saved = result.images[0].filename
    const files = await readdir(join(workdir, 'uploads', 'sess-1'))
    expect(files).toContain(saved)
    const bytes = await readFile(join(workdir, 'uploads', 'sess-1', saved))
    expect(new Uint8Array(bytes)).toEqual(png)
  })

  test('throws a useful error on a non-2xx API response', async () => {
    process.env.IDEOGRAM_API_KEY = 'test-key'
    globalThis.fetch = (async () =>
      new Response('bad request: invalid aspect_ratio', { status: 422 })) as unknown as typeof fetch
    await expect(generateImage({ prompt: 'x' }, 'sess-2')).rejects.toThrow(/Ideogram API error \(422\)/)
  })

  test('throws when the API returns no images', async () => {
    process.env.IDEOGRAM_API_KEY = 'test-key'
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(generateImage({ prompt: 'x' }, 'sess-3')).rejects.toThrow(/no images/)
  })
})
