// Tests for the gccli boot shim (Phase 0.B.5):
//   - mintGoogleToken: request shape (URL, auth header, body, response parse)
//   - writeAccountsJson: round-trip + merge-by-email semantics
//   - startGccliShim: writes accounts.json when the controller returns
//     an email; warns + skips writes when it doesn't.
//
// Network is fully mocked — no controller calls leave the test process.

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  mintGoogleToken,
  readShimConfig,
  startGccliShim,
  stopGccliShim,
  writeAccountsJson,
  writeGccliAccounts,
} from '../src/gccli-shim'

const ROOT = await mkdtemp(join(tmpdir(), 'pi-harness-gccli-'))

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('mintGoogleToken', () => {
  test('POSTs to /api/oauth/google/access-token with bearer auth + JSON body', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
      captured = { url: String(input), init: init ?? {} }
      return new Response(
        JSON.stringify({
          access_token: 'ya29.fake',
          expires_in: 3599,
          email: 'cb@example.com',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const out = await mintGoogleToken(
      {
        userId: '11111111-2222-4333-8444-555555555555',
        controllerBaseUrl: 'https://ctrl.example/',
        controllerServiceToken: 'svc-token',
      },
      fakeFetch,
    )

    expect(out).toEqual({
      access_token: 'ya29.fake',
      expires_in: 3599,
      email: 'cb@example.com',
    })
    expect(captured).not.toBeNull()
    const c = captured as unknown as { url: string; init: RequestInit }
    // Trailing slash on base URL must produce a single slash before /api/...
    expect(c.url).toBe('https://ctrl.example//api/oauth/google/access-token')
    expect(c.init.method).toBe('POST')
    const headers = c.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer svc-token')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(c.init.body as string) as { userId: string }
    expect(body.userId).toBe('11111111-2222-4333-8444-555555555555')
  })

  test('omits email field when controller response lacks it', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ access_token: 'ya29.no-email', expires_in: 3599 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    const out = await mintGoogleToken(
      {
        userId: 'u',
        controllerBaseUrl: 'https://ctrl.example',
        controllerServiceToken: 'svc',
      },
      fakeFetch,
    )
    expect(out.access_token).toBe('ya29.no-email')
    expect(out.expires_in).toBe(3599)
    expect(out.email).toBeUndefined()
  })

  test('throws on non-2xx with body in message', async () => {
    const fakeFetch = (async () =>
      new Response('not authorized', { status: 401 })) as unknown as typeof fetch
    await expect(
      mintGoogleToken(
        {
          userId: 'u',
          controllerBaseUrl: 'https://ctrl.example',
          controllerServiceToken: 'svc',
        },
        fakeFetch,
      ),
    ).rejects.toThrow(/401.*not authorized/)
  })

  test('throws when response is missing access_token or expires_in', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: 'only' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    await expect(
      mintGoogleToken(
        {
          userId: 'u',
          controllerBaseUrl: 'https://ctrl.example',
          controllerServiceToken: 'svc',
        },
        fakeFetch,
      ),
    ).rejects.toThrow(/missing access_token/)
  })
})

describe('writeAccountsJson', () => {
  test('creates parent dir and writes a fresh array when file is absent', async () => {
    const path = join(ROOT, 'fresh', 'accounts.json')
    await writeAccountsJson(path, {
      email: 'alice@example.com',
      oauth2: {
        clientId: 'cid',
        clientSecret: 'csec',
        refreshToken: 'placeholder',
        accessToken: 'AT-1',
      },
    })
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Array<{ email: string; oauth2: { accessToken?: string } }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.email).toBe('alice@example.com')
    expect(parsed[0]!.oauth2.accessToken).toBe('AT-1')
  })

  test('updates an existing entry in place when email matches', async () => {
    const path = join(ROOT, 'merge', 'accounts.json')
    await writeAccountsJson(path, {
      email: 'bob@example.com',
      oauth2: { clientId: 'c', clientSecret: 's', refreshToken: 'p', accessToken: 'AT-old' },
    })
    await writeAccountsJson(path, {
      email: 'bob@example.com',
      oauth2: { clientId: 'c', clientSecret: 's', refreshToken: 'p', accessToken: 'AT-new' },
    })
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Array<{
      email: string
      oauth2: { accessToken?: string }
    }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.oauth2.accessToken).toBe('AT-new')
  })

  test('appends a new entry when email is novel, preserving existing', async () => {
    const path = join(ROOT, 'append', 'accounts.json')
    await writeAccountsJson(path, {
      email: 'first@example.com',
      oauth2: { clientId: 'c', clientSecret: 's', refreshToken: 'p', accessToken: 'AT-1' },
    })
    await writeAccountsJson(path, {
      email: 'second@example.com',
      oauth2: { clientId: 'c', clientSecret: 's', refreshToken: 'p', accessToken: 'AT-2' },
    })
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Array<{ email: string }>
    expect(parsed.map((p) => p.email)).toEqual([
      'first@example.com',
      'second@example.com',
    ])
  })

  test('overwrites a corrupt accounts.json without throwing', async () => {
    const path = join(ROOT, 'corrupt', 'accounts.json')
    await writeAccountsJson(path, {
      email: 'seed@example.com',
      oauth2: { clientId: 'c', clientSecret: 's', refreshToken: 'p', accessToken: 'X' },
    })
    await writeFile(path, '{not valid json', 'utf8')
    await writeAccountsJson(path, {
      email: 'seed@example.com',
      oauth2: { clientId: 'c', clientSecret: 's', refreshToken: 'p', accessToken: 'OK' },
    })
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Array<{
      oauth2: { accessToken?: string }
    }>
    expect(parsed[0]!.oauth2.accessToken).toBe('OK')
  })
})

describe('writeGccliAccounts', () => {
  test('writes to all three connector dirs (gccli, gdcli, gmcli)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-harness-home-'))
    try {
      await writeGccliAccounts(
        {
          email: 'multi@example.com',
          accessToken: 'AT-multi',
          googleClientId: 'gcid',
          googleClientSecret: 'gcsec',
        },
        home,
      )
      for (const dir of ['.gccli', '.gdcli', '.gmcli']) {
        const path = join(home, dir, 'accounts.json')
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Array<{
          email: string
          oauth2: { clientId: string; accessToken?: string }
        }>
        expect(parsed[0]!.email).toBe('multi@example.com')
        expect(parsed[0]!.oauth2.clientId).toBe('gcid')
        expect(parsed[0]!.oauth2.accessToken).toBe('AT-multi')
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('readShimConfig', () => {
  test('returns null when controller env vars are missing', () => {
    expect(readShimConfig({})).toBeNull()
    expect(readShimConfig({ CONTROLLER_BASE_URL: 'https://x' })).toBeNull()
    expect(readShimConfig({ CONTROLLER_SERVICE_TOKEN: 'tok' })).toBeNull()
  })

  test('strips trailing slashes from base URL', () => {
    const cfg = readShimConfig({
      CONTROLLER_BASE_URL: 'https://ctrl.example///',
      CONTROLLER_SERVICE_TOKEN: 'tok',
    })
    expect(cfg?.controllerBaseUrl).toBe('https://ctrl.example')
  })

  test('captures Google client config when present', () => {
    const cfg = readShimConfig({
      CONTROLLER_BASE_URL: 'https://ctrl.example',
      CONTROLLER_SERVICE_TOKEN: 'tok',
      GOOGLE_OAUTH_CLIENT_ID: 'cid',
      GOOGLE_OAUTH_CLIENT_SECRET: 'csec',
    })
    expect(cfg?.googleClientId).toBe('cid')
    expect(cfg?.googleClientSecret).toBe('csec')
  })
})

describe('startGccliShim', () => {
  test('writes accounts.json when controller returns email in mint response', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-harness-home-'))
    try {
      const fakeFetch = (async () =>
        new Response(
          JSON.stringify({
            access_token: 'AT-with-email',
            expires_in: 3599,
            email: 'response@example.com',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch
      await startGccliShim({
        userId: 'u-with-email',
        config: {
          controllerBaseUrl: 'https://ctrl.example',
          controllerServiceToken: 'svc',
          googleClientId: 'gcid',
          googleClientSecret: 'gcsec',
        },
        home,
        fetchImpl: fakeFetch,
        intervalMs: 60_000,
      })
      stopGccliShim()
      for (const dir of ['.gccli', '.gdcli', '.gmcli']) {
        const path = join(home, dir, 'accounts.json')
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Array<{
          email: string
          oauth2: { accessToken?: string }
        }>
        expect(parsed[0]!.email).toBe('response@example.com')
        expect(parsed[0]!.oauth2.accessToken).toBe('AT-with-email')
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('warns + skips writes when controller omits email', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-harness-home-'))
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      const fakeFetch = (async () =>
        new Response(
          JSON.stringify({ access_token: 'AT-no-email', expires_in: 3599 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch
      await startGccliShim({
        userId: 'u-no-email',
        config: {
          controllerBaseUrl: 'https://ctrl.example',
          controllerServiceToken: 'svc',
          googleClientId: 'gcid',
          googleClientSecret: 'gcsec',
        },
        home,
        fetchImpl: fakeFetch,
        intervalMs: 60_000,
      })
      stopGccliShim()
      // No accounts.json written anywhere.
      for (const dir of ['.gccli', '.gdcli', '.gmcli']) {
        expect(existsSync(join(home, dir, 'accounts.json'))).toBe(false)
      }
      // Warning was emitted.
      expect(warnings.some((w) => w.includes('controller returned no email'))).toBe(true)
    } finally {
      console.warn = origWarn
      await rm(home, { recursive: true, force: true })
    }
  })
})
